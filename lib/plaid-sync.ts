import type { SupabaseClient } from '@supabase/supabase-js'
import type { RemovedTransaction, Transaction as PlaidTransaction } from 'plaid'
import { createServiceClient } from './supabase/service'
import {
  describePlaidError,
  needsReauth,
  plaidClient,
  isPlaidConfigured,
} from './plaid-client'
import { decryptToken } from './plaid-crypto'
import { runAutoClear } from './obligation-auto-clear-service'
import {
  PLAID_AMOUNT_CONVENTION,
  mapTransaction,
  type MappedTransaction,
  type PlaidAccountMapping,
} from './plaid-transform'

/**
 * Incremental Plaid transaction sync.
 *
 * Mirrors lib/square-sync.ts: service-role writes, a persisted cursor so each run
 * only fetches what changed, and fail-closed error handling that records the
 * failure instead of silently importing a partial batch.
 *
 * The two invariants that matter most here:
 *  1. Nothing is written before an account's cutover date, or Plaid's 24 months of
 *     history would land on top of the 1,434 rows already imported from CSV under
 *     different transaction ids.
 *  2. The cursor is only advanced after the rows for that page are safely written.
 *     Advancing first would permanently skip transactions on any failure.
 */

export type PlaidSyncResult = {
  itemId: string
  institution: string | null
  added: number
  modified: number
  removed: number
  skippedBeforeCutover: number
  skippedUnmapped: number
  status: 'ok' | 'error' | 'skipped' | 'pending'
  message?: string
  needsReauth?: boolean
}

type ItemRow = {
  item_id: string
  institution_name: string | null
  access_token_encrypted: string
  cursor: string | null
  status: string
}

/** Load the account mapping for one item, keyed by Plaid account_id. */
async function loadMappings(
  db: SupabaseClient,
  itemId: string,
): Promise<Map<string, PlaidAccountMapping>> {
  const { data, error } = await db
    .from('plaid_accounts')
    .select('account_id, account_name, import_from_date, is_enabled')
    .eq('item_id', itemId)

  if (error) throw new Error(`Failed to load Plaid account mapping: ${error.message}`)

  const out = new Map<string, PlaidAccountMapping>()
  for (const row of data ?? []) {
    // An account with no account_name has not been mapped by the owner yet.
    // Treat it as disabled rather than inventing a label, which would create a
    // brand-new account in every report.
    if (!row.account_name) continue
    out.set(row.account_id, {
      accountId: row.account_id,
      accountName: row.account_name,
      amountConvention: PLAID_AMOUNT_CONVENTION,
      importFromDate: row.import_from_date ?? null,
      isEnabled: row.is_enabled !== false,
    })
  }
  return out
}

/**
 * Write a page of mapped rows.
 *
 * Upserts on external_transaction_id, which carries a partial unique index. That
 * makes the write idempotent at the database level: re-running a page cannot
 * duplicate rows even if the cursor was not advanced.
 *
 * `ignoreDuplicates: false` so that a settled pending transaction (same id, new
 * amount and date) updates in place.
 */
async function writeRows(
  db: SupabaseClient,
  rows: MappedTransaction[],
): Promise<void> {
  if (rows.length === 0) return

  const { error } = await db
    .from('financial_transactions')
    .upsert(rows, {
      onConflict: 'external_transaction_id',
      ignoreDuplicates: false,
    })

  if (error) throw new Error(`Failed to write Plaid transactions: ${error.message}`)
}

/**
 * Soft-delete transactions Plaid has retracted.
 *
 * Uses deleted_at rather than a hard delete so the row stays auditable and any
 * category work the owner did on it is not destroyed, matching how the rest of the
 * app treats removals.
 */
async function removeRows(
  db: SupabaseClient,
  removed: RemovedTransaction[],
): Promise<number> {
  const ids = removed.map((r) => r.transaction_id).filter(Boolean) as string[]
  if (ids.length === 0) return 0

  const { error, count } = await db
    .from('financial_transactions')
    .update({ deleted_at: new Date().toISOString() }, { count: 'exact' })
    .in('external_transaction_id', ids)
    .is('deleted_at', null)

  if (error) throw new Error(`Failed to remove Plaid transactions: ${error.message}`)
  return count ?? 0
}

async function recordState(
  db: SupabaseClient,
  itemId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db
    .from('plaid_sync_state')
    .upsert(
      { item_id: itemId, updated_at: new Date().toISOString(), ...patch },
      { onConflict: 'item_id' },
    )
}

/** Sync one Plaid item (one bank login) to completion. */
export async function syncItem(
  item: ItemRow,
  db: SupabaseClient,
): Promise<PlaidSyncResult> {
  const result: PlaidSyncResult = {
    itemId: item.item_id,
    institution: item.institution_name,
    added: 0,
    modified: 0,
    removed: 0,
    skippedBeforeCutover: 0,
    skippedUnmapped: 0,
    status: 'ok',
  }

  await recordState(db, item.item_id, {
    last_run_at: new Date().toISOString(),
    status: 'running',
  })

  try {
    const mappings = await loadMappings(db, item.item_id)
    if (mappings.size === 0) {
      result.status = 'skipped'
      result.message =
        'No accounts mapped yet. Set the account name in Settings before syncing.'
      await recordState(db, item.item_id, {
        status: 'skipped',
        last_error: result.message,
      })
      return result
    }

    const client = plaidClient()
    const accessToken = decryptToken(item.access_token_encrypted)

    let cursor = item.cursor ?? undefined
    let hasMore = true
    // Hard stop so a malfunctioning cursor cannot loop forever inside a cron
    // invocation. 60 pages x 500 = 30k transactions, far beyond a farm's volume.
    let pages = 0
    const MAX_PAGES = 60

    // A freshly connected Item has no transactions prepared yet. Plaid signals
    // this by returning empty added/modified/removed AND an empty next_cursor.
    // Verified in Sandbox: the first call returns 0 rows, then ~3s later 16 rows.
    // Without this wait the owner clicks "Sync now", sees "0 transactions", and
    // reasonably concludes the integration is broken.
    let notReadyWaits = 0
    const MAX_NOT_READY_WAITS = 5
    const NOT_READY_DELAY_MS = 3000

    while (hasMore && pages < MAX_PAGES) {
      pages += 1

      const response = await client.transactionsSync({
        access_token: accessToken,
        cursor,
        count: 500,
      })
      const data = response.data

      const nothingReturned =
        (data.added ?? []).length === 0 &&
        (data.modified ?? []).length === 0 &&
        (data.removed ?? []).length === 0

      // Plaid returns "" for next_cursor while an Item is still initialising.
      const cursorIsEmpty = !data.next_cursor

      if (nothingReturned && cursorIsEmpty && !data.has_more) {
        if (notReadyWaits < MAX_NOT_READY_WAITS) {
          notReadyWaits += 1
          pages -= 1 // a wait is not a real page
          await new Promise((r) => setTimeout(r, NOT_READY_DELAY_MS))
          continue
        }
        // Still not ready after waiting. Leave the stored cursor untouched and
        // report honestly rather than claiming a successful empty sync.
        result.status = 'pending'
        result.message =
          'The bank is still preparing this account. Nothing was imported yet - run Sync again in a minute.'
        await recordState(db, item.item_id, {
          status: 'pending',
          last_error: result.message,
        })
        return result
      }

      const added = collect(data.added ?? [], mappings, result)
      const modified = collect(data.modified ?? [], mappings, result)

      await writeRows(db, added)
      await writeRows(db, modified)
      result.added += added.length
      result.modified += modified.length
      result.removed += await removeRows(db, data.removed ?? [])

      // Persist the cursor only after this page's rows are committed. If the run
      // dies mid-way, the next run re-fetches this page rather than skipping it,
      // and the upsert makes the retry harmless.
      //
      // Never overwrite a good cursor with an empty one: that would silently reset
      // the Item to "fetch everything from scratch" on the next run.
      hasMore = data.has_more
      if (data.next_cursor) {
        cursor = data.next_cursor
        await db
          .from('plaid_items')
          .update({ cursor, updated_at: new Date().toISOString() })
          .eq('item_id', item.item_id)
      }
    }

    if (hasMore) {
      result.message = `Stopped after ${MAX_PAGES} pages; the next run will continue.`
    }

    await recordState(db, item.item_id, {
      status: 'ok',
      last_success_at: new Date().toISOString(),
      last_error: null,
      records_synced: result.added + result.modified,
      added_count: result.added,
      modified_count: result.modified,
      removed_count: result.removed,
      skipped_before_cutover: result.skippedBeforeCutover,
    })

    await db
      .from('plaid_items')
      .update({ status: 'active', last_error: null })
      .eq('item_id', item.item_id)

    return result
  } catch (err) {
    const message = describePlaidError(err)
    const reauth = needsReauth(err)

    result.status = 'error'
    result.message = message
    result.needsReauth = reauth

    await recordState(db, item.item_id, { status: 'error', last_error: message })
    await db
      .from('plaid_items')
      .update({
        // Surface re-authentication distinctly: it is the one failure the owner
        // must fix by hand, by reconnecting the bank in Settings.
        status: reauth ? 'reauth_required' : 'error',
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq('item_id', item.item_id)

    return result
  }
}

/** Map a batch, counting the rows that were deliberately skipped. */
function collect(
  batch: PlaidTransaction[],
  mappings: Map<string, PlaidAccountMapping>,
  result: PlaidSyncResult,
): MappedTransaction[] {
  const out: MappedTransaction[] = []
  for (const t of batch) {
    const mapping = mappings.get(t.account_id)
    if (!mapping) {
      result.skippedUnmapped += 1
      continue
    }
    const row = mapTransaction(t, mapping)
    if (!row) {
      // Distinguish a cutover skip (expected, and the whole point of the guard)
      // from a disabled account, so the Settings panel can explain the number.
      if (mapping.isEnabled) result.skippedBeforeCutover += 1
      else result.skippedUnmapped += 1
      continue
    }
    out.push(row)
  }
  return out
}

/** Sync every active Plaid item. Used by the cron route and the manual button. */
export async function syncAllItems(): Promise<{
  results: PlaidSyncResult[]
  configured: boolean
}> {
  if (!isPlaidConfigured()) {
    return { results: [], configured: false }
  }

  const db = createServiceClient()
  const { data, error } = await db
    .from('plaid_items')
    .select('item_id, institution_name, access_token_encrypted, cursor, status')
    .neq('status', 'disconnected')

  if (error) throw new Error(`Failed to load Plaid items: ${error.message}`)

  const results: PlaidSyncResult[] = []
  for (const item of (data ?? []) as ItemRow[]) {
    // Sequential on purpose: one failing institution must not abort the others,
    // and Plaid rate-limits per client.
    results.push(await syncItem(item, db))
  }

  // Fresh bank rows are exactly when a mailed check shows up as cleared, so match those
  // checks to the bills they paid now rather than waiting for the owner to press
  // anything.
  //
  // Hooked here rather than inside syncItem so it runs ONCE per sync against the whole
  // ledger: a check written on one account can appear in another institution's feed, and
  // per-item runs would re-scan the same rows N times.
  //
  // Wrapped so a matcher failure can never fail a bank sync. Getting transactions in is
  // the primary job; matching is a convenience on top, and it retries on the next run.
  try {
    const summary = await runAutoClear(db, 'plaid-sync')
    if (summary.cleared > 0 || summary.errors.length > 0) {
      console.log(
        `[v0] auto-clear: ${summary.cleared} cleared, ${summary.needsReview} to review, ${summary.skipped} skipped`,
        summary.errors.length > 0 ? summary.errors : '',
      )
    }
  } catch (err) {
    console.log('[v0] auto-clear after sync failed (transactions still synced):', err)
  }

  return { results, configured: true }
}
