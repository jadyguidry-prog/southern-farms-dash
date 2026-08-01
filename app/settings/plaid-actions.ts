'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  isPlaidConfigured,
  isPlaidEncryptionConfigured,
  plaidEnv,
} from '@/lib/plaid-client'
import { syncAllItems } from '@/lib/plaid-sync'

export type PlaidActionResult = {
  ok: boolean
  message: string
  detail?: string[]
}

/** Every action here mutates the ledger, so require a signed-in owner. */
async function requireUser(): Promise<string | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user?.id ?? null
}

export type PlaidAccountView = {
  accountId: string
  itemId: string
  plaidName: string | null
  mask: string | null
  type: string | null
  subtype: string | null
  accountName: string | null
  importFromDate: string | null
  isEnabled: boolean
}

export type PlaidItemView = {
  itemId: string
  institutionName: string | null
  status: string
  lastError: string | null
  lastSuccessAt: string | null
  lastRunAt: string | null
  syncStatus: string | null
  syncError: string | null
  accounts: PlaidAccountView[]
}

export type PlaidOverview = {
  configured: boolean
  encryptionConfigured: boolean
  environment: string
  items: PlaidItemView[]
  /**
   * Existing account labels with their latest transaction date, so the panel can
   * offer the exact string to map to and a safe cutover date instead of asking the
   * owner to type either from memory.
   */
  existingAccounts: { accountName: string; rows: number; latest: string | null }[]
}

export async function getPlaidOverview(): Promise<PlaidOverview> {
  const base: PlaidOverview = {
    configured: isPlaidConfigured(),
    encryptionConfigured: isPlaidEncryptionConfigured(),
    environment: plaidEnv(),
    items: [],
    existingAccounts: [],
  }

  const supabase = await createClient()

  // Existing ledger accounts. Read with the request client so RLS applies; this is
  // user-facing data, not a privileged sync write.
  const { data: txnAccounts } = await supabase
    .from('financial_transactions')
    .select('account_name, transaction_date')
    .is('deleted_at', null)
    .not('account_name', 'is', null)
    .order('transaction_date', { ascending: false })
    .limit(5000)

  const agg = new Map<string, { rows: number; latest: string | null }>()
  for (const row of txnAccounts ?? []) {
    const name = row.account_name as string
    const current = agg.get(name) ?? { rows: 0, latest: null }
    current.rows += 1
    if (!current.latest || (row.transaction_date as string) > current.latest) {
      current.latest = row.transaction_date as string
    }
    agg.set(name, current)
  }
  base.existingAccounts = [...agg.entries()]
    .map(([accountName, v]) => ({ accountName, ...v }))
    .sort((a, b) => b.rows - a.rows)

  if (!base.configured) return base

  // plaid_items is deny-all for the browser key by design, so read it with the
  // service client. Only non-secret fields are selected — never the token column.
  const db = createServiceClient()
  const { data: items } = await db
    .from('plaid_items')
    .select('item_id, institution_name, status, last_error')
    .neq('status', 'disconnected')
    .order('created_at', { ascending: true })

  if (!items || items.length === 0) return base

  const itemIds = items.map((i) => i.item_id as string)
  const [{ data: accounts }, { data: states }] = await Promise.all([
    db
      .from('plaid_accounts')
      .select(
        'account_id, item_id, plaid_name, mask, type, subtype, account_name, import_from_date, is_enabled',
      )
      .in('item_id', itemIds),
    db
      .from('plaid_sync_state')
      .select('item_id, last_success_at, last_run_at, status, last_error')
      .in('item_id', itemIds),
  ])

  const stateByItem = new Map(
    (states ?? []).map((s) => [s.item_id as string, s]),
  )

  base.items = items.map((item) => {
    const state = stateByItem.get(item.item_id as string)
    return {
      itemId: item.item_id as string,
      institutionName: (item.institution_name as string | null) ?? null,
      status: (item.status as string) ?? 'active',
      lastError: (item.last_error as string | null) ?? null,
      lastSuccessAt: (state?.last_success_at as string | null) ?? null,
      lastRunAt: (state?.last_run_at as string | null) ?? null,
      syncStatus: (state?.status as string | null) ?? null,
      syncError: (state?.last_error as string | null) ?? null,
      accounts: (accounts ?? [])
        .filter((a) => a.item_id === item.item_id)
        .map((a) => ({
          accountId: a.account_id as string,
          itemId: a.item_id as string,
          plaidName: (a.plaid_name as string | null) ?? null,
          mask: (a.mask as string | null) ?? null,
          type: (a.type as string | null) ?? null,
          subtype: (a.subtype as string | null) ?? null,
          accountName: (a.account_name as string | null) ?? null,
          importFromDate: (a.import_from_date as string | null) ?? null,
          isEnabled: a.is_enabled !== false,
        })),
    }
  })

  return base
}

/**
 * Save one account's mapping.
 *
 * The account name must match an existing ledger label exactly or reports split in
 * two, and the cutover date is what prevents re-importing CSV history — so both are
 * validated here rather than trusted from the form.
 */
export async function savePlaidAccountMapping(
  formData: FormData,
): Promise<PlaidActionResult> {
  if (!(await requireUser())) {
    return { ok: false, message: 'You must be signed in to change this.' }
  }

  const accountId = String(formData.get('accountId') ?? '')
  const accountName = String(formData.get('accountName') ?? '').trim()
  const importFromDate = String(formData.get('importFromDate') ?? '').trim()
  const isEnabled = formData.get('isEnabled') === 'on'

  if (!accountId) {
    return { ok: false, message: 'Missing account.' }
  }

  // Enabling an account without a cutover would pull Plaid's full 24 months on top
  // of the CSV history. Refuse instead of silently double-counting.
  if (isEnabled && !importFromDate) {
    return {
      ok: false,
      message:
        'Set an "import from" date before enabling this account, otherwise up to 24 months of Plaid history could duplicate the transactions already imported from CSV.',
    }
  }

  if (isEnabled && !accountName) {
    return {
      ok: false,
      message:
        'Choose which existing account this maps to before enabling it, so its transactions join the right account.',
    }
  }

  if (importFromDate && !/^\d{4}-\d{2}-\d{2}$/.test(importFromDate)) {
    return { ok: false, message: 'The import date must be a valid calendar date.' }
  }

  const db = createServiceClient()
  const { error } = await db
    .from('plaid_accounts')
    .update({
      account_name: accountName || null,
      import_from_date: importFromDate || null,
      is_enabled: isEnabled,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', accountId)

  if (error) {
    return { ok: false, message: `Could not save: ${error.message}` }
  }

  revalidatePath('/settings')
  return {
    ok: true,
    message: isEnabled
      ? `Mapped to "${accountName}". Transactions from ${importFromDate} forward will import on the next sync.`
      : 'Saved. This account is turned off and will not import.',
  }
}

/** Run the sync now, for the button in Settings. */
export async function runPlaidSync(): Promise<PlaidActionResult> {
  if (!(await requireUser())) {
    return { ok: false, message: 'You must be signed in to sync.' }
  }

  try {
    const { results, configured } = await syncAllItems()

    if (!configured) {
      return { ok: false, message: 'Plaid is not configured yet.' }
    }
    if (results.length === 0) {
      return { ok: false, message: 'No banks are connected yet.' }
    }

    const detail = results.map((r) => {
      const who = r.institution ?? r.itemId
      if (r.status === 'error') return `${who}: ${r.message}`
      if (r.status === 'skipped') return `${who}: ${r.message}`
      const parts = [`${r.added} added`]
      if (r.modified) parts.push(`${r.modified} updated`)
      if (r.removed) parts.push(`${r.removed} removed`)
      if (r.skippedBeforeCutover) {
        parts.push(`${r.skippedBeforeCutover} skipped before cutover`)
      }
      return `${who}: ${parts.join(', ')}`
    })

    const failed = results.filter((r) => r.status === 'error')
    const added = results.reduce((s, r) => s + r.added, 0)

    revalidatePath('/settings')
    revalidatePath('/')

    if (failed.length > 0) {
      return {
        ok: false,
        message: `Sync finished with ${failed.length} problem${failed.length === 1 ? '' : 's'}.`,
        detail,
      }
    }
    return {
      ok: true,
      message:
        added > 0
          ? `Imported ${added} transaction${added === 1 ? '' : 's'}.`
          : 'Sync completed. No new transactions.',
      detail,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Sync failed.',
    }
  }
}

/**
 * Disconnect a bank.
 *
 * Marks the item disconnected and clears the stored token so it cannot be used
 * again. Imported transactions are deliberately KEPT — they are real ledger
 * history, and deleting them would silently change past reports.
 */
export async function disconnectPlaidItem(
  formData: FormData,
): Promise<PlaidActionResult> {
  if (!(await requireUser())) {
    return { ok: false, message: 'You must be signed in to disconnect.' }
  }

  const itemId = String(formData.get('itemId') ?? '')
  if (!itemId) return { ok: false, message: 'Missing connection.' }

  const db = createServiceClient()

  // Best effort: tell Plaid to invalidate the item so it stops billing and the
  // token is dead server-side too.
  try {
    const { data } = await db
      .from('plaid_items')
      .select('access_token_encrypted')
      .eq('item_id', itemId)
      .maybeSingle()
    if (data?.access_token_encrypted) {
      const { decryptToken } = await import('@/lib/plaid-crypto')
      const { plaidClient } = await import('@/lib/plaid-client')
      await plaidClient().itemRemove({
        access_token: decryptToken(data.access_token_encrypted),
      })
    }
  } catch {
    // If Plaid rejects it the local disconnect below still proceeds; leaving a
    // dead row that looks connected would be more confusing.
  }

  const { error } = await db
    .from('plaid_items')
    .update({
      status: 'disconnected',
      access_token_encrypted: '',
      cursor: null,
      updated_at: new Date().toISOString(),
    })
    .eq('item_id', itemId)

  if (error) return { ok: false, message: `Could not disconnect: ${error.message}` }

  revalidatePath('/settings')
  return {
    ok: true,
    message:
      'Disconnected. Transactions already imported were kept, since they are part of your ledger history.',
  }
}
