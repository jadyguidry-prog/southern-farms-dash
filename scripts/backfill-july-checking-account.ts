/**
 * Attach the July 2026 checking import to its account.
 *
 * The `July_2026_Checking_Transactions_Clean.csv` batch landed with
 * `account_name = NULL` on all 116 rows — the importer had no account column to
 * read. They are unmistakably checking rows: the file is the bank's own July
 * export, they run 2026-07-01..2026-07-31, and the existing 945 checking rows
 * stop at 2026-06-30, so July continues that series with no overlap.
 *
 * Why it matters beyond tidiness: per-account reporting and reconciliation key
 * off `account_name`, so 116 unattached rows are invisible to any per-account
 * view, and the "last imported date" for the checking account reads 2026-06-30 —
 * a month stale. That date is exactly what a future Plaid sync would use as its
 * cutover, so leaving it wrong would make an automated sync re-pull all of July
 * and double-count it.
 *
 * This only writes `account_name`. It does not touch amounts, types, or
 * categories. Every change is journalled to `transaction_audit_log` under one
 * `bulk_action_id`, and `revertBulkAction` restores NULL (the undo path maps a
 * null `previous_value` back to NULL), so the whole backfill is reversible from
 * the Category Review UI.
 *
 * Idempotent: rows that already carry the target name are skipped, so a second
 * run reports nothing to do.
 *
 * Dry run (default):  npx tsx scripts/backfill-july-checking-account.ts
 * Apply:              npx tsx scripts/backfill-july-checking-account.ts --apply
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const SOURCE_FILE = 'July_2026_Checking_Transactions_Clean.csv'

/**
 * Read from the data rather than hardcoded: the exact stored spelling includes
 * the account's last four ("... ending 2268"). Typing it by hand risks creating
 * a second, near-identical account that silently splits reporting in two.
 */
const ACCOUNT_MATCH = /lafourche/i

const ACTOR = 'v0-data-repair'
const APPLY = process.argv.includes('--apply')

type Row = {
  id: string
  transaction_date: string | null
  description: string | null
  amount: number | string | null
  account_name: string | null
  source_file_name: string | null
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const money = (n: number) =>
  '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Paginated read: PostgREST silently caps a response at 1,000 rows. */
async function fetchAll(): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('financial_transactions')
      .select('id, transaction_date, description, amount, account_name, source_file_name')
      .is('deleted_at', null)
      .order('id')
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    const page = data ?? []
    out.push(...(page as Row[]))
    if (page.length < 1000) break
  }
  return out
}

async function main() {
  const rows = await fetchAll()

  // Resolve the canonical account name from rows that already have one.
  const spellings = new Map<string, number>()
  for (const r of rows) {
    if (r.account_name && ACCOUNT_MATCH.test(r.account_name)) {
      spellings.set(r.account_name, (spellings.get(r.account_name) ?? 0) + 1)
    }
  }

  if (spellings.size === 0) {
    console.error('No existing checking rows found — cannot resolve the account name.')
    process.exit(1)
  }
  if (spellings.size > 1) {
    // Guessing here could merge or split real accounts. Stop and let a human look.
    console.error('Ambiguous: multiple checking account spellings exist.')
    for (const [name, n] of spellings) console.error(`  ${n} rows  ${JSON.stringify(name)}`)
    process.exit(1)
  }

  const target = [...spellings.keys()][0]
  const existing = spellings.get(target)!

  const batch = rows.filter((r) => r.source_file_name === SOURCE_FILE)
  const todo = batch.filter((r) => r.account_name === null)
  const already = batch.filter((r) => r.account_name === target)

  console.log(`Target account : ${JSON.stringify(target)} (${existing} rows already)`)
  console.log(`Source file    : ${SOURCE_FILE}`)
  console.log(`Batch rows     : ${batch.length}`)
  console.log(`  unattached   : ${todo.length}`)
  console.log(`  already set  : ${already.length}`)

  const otherAccount = batch.filter(
    (r) => r.account_name !== null && r.account_name !== target,
  )
  if (otherAccount.length > 0) {
    // A row in this file claiming a different account means the file is not what
    // we think it is. Never overwrite that silently.
    console.error(`\nAborting: ${otherAccount.length} row(s) already name a DIFFERENT account.`)
    for (const r of otherAccount.slice(0, 5)) {
      console.error(`  ${r.transaction_date}  ${JSON.stringify(r.account_name)}`)
    }
    process.exit(1)
  }

  if (todo.length === 0) {
    console.log('\nNothing to do.')
    return
  }

  // Safety check: the whole premise is that July does not already exist under
  // this account. If it does, these 116 rows may be duplicates rather than the
  // month's only copy, and attaching them would double-count the month.
  const dates = todo.map((r) => (r.transaction_date ?? '').slice(0, 10)).sort()
  const from = dates[0]
  const to = dates[dates.length - 1]

  const overlapping = rows.filter(
    (r) =>
      r.account_name === target &&
      (r.transaction_date ?? '').slice(0, 10) >= from &&
      (r.transaction_date ?? '').slice(0, 10) <= to,
  )

  console.log(`\nDate span      : ${from} -> ${to}`)
  console.log(`Existing rows already on this account in that span: ${overlapping.length}`)
  if (overlapping.length > 0) {
    console.error('\nAborting: this account already has rows in the same span.')
    console.error('Attaching these could double-count the month. Inspect before proceeding.')
    for (const r of overlapping.slice(0, 5)) {
      console.error(`  ${r.transaction_date}  ${money(Number(r.amount))}  ${r.description}`)
    }
    process.exit(1)
  }

  const total = todo.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0)
  console.log(`Rows to attach : ${todo.length}  (${money(total)} of activity)`)
  console.log('\nSample:')
  for (const r of todo.slice(0, 6)) {
    console.log(
      `  ${r.transaction_date}  ${money(Number(r.amount)).padStart(12)}  ${(r.description ?? '').slice(0, 44)}`,
    )
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to attach ${todo.length} rows.`)
    return
  }

  const bulkActionId = randomUUID()
  const ids = todo.map((r) => r.id)

  // Journal BEFORE mutating: if the update fails we have a harmless extra log
  // entry, whereas the reverse order could change data with no way back.
  const audit = todo.map((r) => ({
    transaction_id: r.id,
    field: 'account_name',
    previous_value: null,
    new_value: target,
    action: 'backfill_account_name',
    bulk_action_id: bulkActionId,
    actor_email: ACTOR,
    reason: `Unattached rows from ${SOURCE_FILE} assigned to their checking account.`,
  }))

  for (let i = 0; i < audit.length; i += 200) {
    const { error } = await db.from('transaction_audit_log').insert(audit.slice(i, i + 200))
    if (error) {
      console.error('Audit write failed, nothing changed:', error.message)
      process.exit(1)
    }
  }

  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await db
      .from('financial_transactions')
      .update({ account_name: target })
      .in('id', ids.slice(i, i + 200))
    if (error) {
      console.error('Update failed:', error.message)
      console.error(`Partial change may exist. Undo with bulk_action_id ${bulkActionId}`)
      process.exit(1)
    }
  }

  // Verify by re-reading rather than trusting the write.
  const after = await fetchAll()
  const stillNull = after.filter(
    (r) => r.source_file_name === SOURCE_FILE && r.account_name === null,
  ).length
  const attached = after.filter((r) => r.account_name === target).length

  console.log(`\nApplied. ${todo.length} rows attached to ${JSON.stringify(target)}.`)
  console.log(`  rows on this account now : ${attached} (was ${existing})`)
  console.log(`  still unattached in batch: ${stillNull}`)
  console.log(`  undo with bulk_action_id : ${bulkActionId}`)
  if (stillNull !== 0) {
    console.error('  WARNING: expected 0 unattached rows remaining.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
