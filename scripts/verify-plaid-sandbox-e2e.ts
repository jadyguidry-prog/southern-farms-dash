/**
 * End-to-end Plaid Sandbox test against the REAL cron route.
 *
 * Creates a throwaway Sandbox Item, maps one account to a sentinel account name,
 * triggers /api/cron/plaid-sync over HTTP (the actual production path), asserts the
 * rows landed with this app's sign convention, then removes everything.
 *
 * Safety: every write is scoped to the sentinel account name below, and the teardown
 * runs in a finally block. The script asserts the live ledger count is identical
 * before and after, so a failed run cannot silently leave test rows behind.
 *
 * Usage: npx tsx scripts/verify-plaid-sandbox-e2e.ts
 */
import { createClient } from '@supabase/supabase-js'
import { Products } from 'plaid'
import { plaidClient, describePlaidError } from '../lib/plaid-client'
import { encryptToken } from '../lib/plaid-crypto'

const SENTINEL = '__PLAID_SANDBOX_TEST__'
const SENTINEL_INSTITUTION = 'SANDBOX TEST BANK'
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'

let failures = 0
function ok(label: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`)
  }
}

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

async function liveCount(client: ReturnType<typeof db>) {
  const { count } = await client
    .from('financial_transactions')
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null)
  return count ?? -1
}

async function teardown(client: ReturnType<typeof db>, accessToken: string) {
  if (accessToken) {
    try {
      await plaidClient().itemRemove({ access_token: accessToken })
    } catch {
      // The Item may already be gone; teardown of local rows still matters.
    }
  }
  await client.from('financial_transactions').delete().eq('account_name', SENTINEL)
  await client.from('plaid_accounts').delete().eq('account_name', SENTINEL)
  await client.from('plaid_items').delete().eq('institution_name', SENTINEL_INSTITUTION)
}

async function main() {
  const client = db()
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.log('CRON_SECRET is not set; cannot call the cron route.')
    process.exit(1)
  }

  const before = await liveCount(client)
  console.log(`ledger rows before: ${before}\n`)

  let accessToken = ''
  try {
    const plaid = plaidClient()

    // 1. Throwaway Sandbox Item.
    const pt = await plaid.sandboxPublicTokenCreate({
      institution_id: 'ins_109508',
      initial_products: [Products.Transactions],
    })
    const ex = await plaid.itemPublicTokenExchange({ public_token: pt.data.public_token })
    accessToken = ex.data.access_token
    const itemId = ex.data.item_id

    await client.from('plaid_items').insert({
      item_id: itemId,
      institution_id: 'ins_109508',
      institution_name: SENTINEL_INSTITUTION,
      access_token_encrypted: encryptToken(accessToken),
      status: 'active',
    })

    // 2. Map one checking account, cutover far in the past so nothing filters out.
    const accounts = (await plaid.accountsGet({ access_token: accessToken })).data.accounts
    const checking = accounts.find((a) => a.subtype === 'checking')
    if (!checking) throw new Error('sandbox returned no checking account')

    await client.from('plaid_accounts').insert({
      item_id: itemId,
      account_id: checking.account_id,
      plaid_name: checking.name,
      mask: checking.mask,
      type: String(checking.type),
      subtype: String(checking.subtype),
      account_name: SENTINEL,
      amount_convention: 'bank',
      import_from_date: '2020-01-01',
      is_enabled: true,
    })
    console.log(`mapped "${checking.name}" -> ${SENTINEL}\n`)

    // 3. Trigger the REAL cron route. Retry while the Item warms up.
    console.log('calling /api/cron/plaid-sync ...')
    let body: any = null
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const res = await fetch(`${BASE_URL}/api/cron/plaid-sync`, {
        headers: { Authorization: `Bearer ${cronSecret}` },
      })
      body = await res.json().catch(() => null)
      const statuses = (body?.results ?? []).map((r: any) => r.status).join(',')
      console.log(`  attempt ${attempt}: http=${res.status} statuses=[${statuses || 'none'}]`)
      ok(`cron route returned 200 (attempt ${attempt})`, res.status === 200)
      const added = (body?.results ?? []).reduce((s: number, r: any) => s + (r.added ?? 0), 0)
      if (added > 0) break
      await new Promise((r) => setTimeout(r, 4000))
    }

    // 4. Assert what landed.
    const { data: rows } = await client
      .from('financial_transactions')
      .select(
        'transaction_date,description,amount,transaction_type,source,external_transaction_id,account_name,statement_month',
      )
      .eq('account_name', SENTINEL)
      .order('transaction_date')

    const written = rows ?? []
    console.log(`\nrows written: ${written.length}`)
    for (const r of written.slice(0, 8)) {
      console.log(
        `   ${r.transaction_date} ${String(r.amount).padStart(9)} ${String(r.transaction_type).padEnd(8)} ${String(r.description).slice(0, 26)}`,
      )
    }

    console.log('\nassertions:')
    ok('rows were imported', written.length > 0, `${written.length} rows`)

    const expenses = written.filter((r) => r.transaction_type === 'expense')
    ok(
      'every expense is negative (app convention)',
      expenses.length > 0 && expenses.every((r) => Number(r.amount) < 0),
      `${expenses.length} expense rows`,
    )

    const income = written.filter((r) => r.transaction_type === 'income')
    ok(
      'every income row is positive',
      income.every((r) => Number(r.amount) > 0),
      `${income.length} income rows`,
    )

    ok('all rows tagged source=plaid', written.every((r) => r.source === 'plaid'))
    ok('all rows carry a Plaid transaction id', written.every((r) => !!r.external_transaction_id))
    ok('all rows have statement_month', written.every((r) => !!r.statement_month))
    ok(
      'no row leaked a null account_name',
      written.every((r) => r.account_name === SENTINEL),
    )

    // 5. Idempotency: a second run must not duplicate.
    console.log('\nidempotency — second cron run:')
    const res2 = await fetch(`${BASE_URL}/api/cron/plaid-sync`, {
      headers: { Authorization: `Bearer ${cronSecret}` },
    })
    const body2 = await res2.json().catch(() => null)
    const added2 = (body2?.results ?? []).reduce((s: number, r: any) => s + (r.added ?? 0), 0)
    const { count: afterSecond } = await client
      .from('financial_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('account_name', SENTINEL)
    ok(
      'second run did not duplicate rows',
      (afterSecond ?? -1) === written.length,
      `${written.length} -> ${afterSecond} (added reported: ${added2})`,
    )

    // 6. Cutover filter: move the cutover forward, confirm older rows are excluded.
    console.log('\ncutover filter:')
    const dates = written.map((r) => r.transaction_date).sort()
    const mid = dates[Math.floor(dates.length / 2)]

    // The cursor lives on plaid_items, NOT plaid_accounts. Sending it to
    // plaid_accounts makes PostgREST reject the whole update, which previously left
    // import_from_date unchanged and made this test report a phantom sync bug.
    // Assert both writes so a silent rejection can never do that again.
    const { error: acctErr } = await client
      .from('plaid_accounts')
      .update({ import_from_date: mid })
      .eq('account_name', SENTINEL)
    ok('cutover date update succeeded', !acctErr, acctErr?.message ?? `import_from_date=${mid}`)

    const { error: itemErr } = await client
      .from('plaid_items')
      .update({ cursor: null })
      .eq('institution_name', SENTINEL_INSTITUTION)
    ok('cursor reset succeeded', !itemErr, itemErr?.message ?? 'cursor=null')

    // Confirm the value actually landed before drawing conclusions from the sync.
    const { data: mapCheck } = await client
      .from('plaid_accounts')
      .select('import_from_date')
      .eq('account_name', SENTINEL)
      .single()
    ok('cutover is readable back', mapCheck?.import_from_date === mid, `stored=${mapCheck?.import_from_date}`)

    await client.from('financial_transactions').delete().eq('account_name', SENTINEL)

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const res3 = await fetch(`${BASE_URL}/api/cron/plaid-sync`, {
        headers: { Authorization: `Bearer ${cronSecret}` },
      })
      const body3 = await res3.json().catch(() => null)
      const added3 = (body3?.results ?? []).reduce((s: number, r: any) => s + (r.added ?? 0), 0)
      const skipped = (body3?.results ?? []).reduce(
        (s: number, r: any) => s + (r.skippedBeforeCutover ?? 0),
        0,
      )
      if (added3 > 0 || skipped > 0) {
        console.log(`  cutover=${mid} added=${added3} skippedBeforeCutover=${skipped}`)
        ok('rows before the cutover were skipped', skipped > 0, `${skipped} skipped`)
        const { data: after } = await client
          .from('financial_transactions')
          .select('transaction_date')
          .eq('account_name', SENTINEL)
        ok(
          'no imported row predates the cutover',
          (after ?? []).every((r) => r.transaction_date >= mid),
        )
        break
      }
      await new Promise((r) => setTimeout(r, 4000))
    }
  } catch (err) {
    failures += 1
    console.log('ERROR:', describePlaidError(err))
  } finally {
    await teardown(client, accessToken)
    const after = await liveCount(client)
    console.log('')
    ok('ledger returned to its original count', after === before, `${before} -> ${after}`)
  }

  console.log('')
  if (failures === 0) {
    console.log('all sandbox e2e checks passed')
  } else {
    console.log(`${failures} check(s) failed`)
    process.exit(1)
  }
}

void main()
