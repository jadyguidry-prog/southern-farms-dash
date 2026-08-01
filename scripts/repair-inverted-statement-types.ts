/**
 * Repair an import whose direction column was read as a transaction type.
 *
 * The importer used to trust a statement's type column verbatim. A bank writes
 * "Credit" for money in and "Debit" for money out, but in this app `credit` is a
 * SPEND OFFSET (a refund that reduces spending). So a checking-account export
 * landed with every deposit stored as `credit` and every payment inferred as
 * `income` — the exact inverse of the truth.
 *
 * Effect on the July 2026 batch: 51 deposits totalling $97,643 were subtracted
 * from $1,527 of real costs, and the Cash Flow chart reported cash out of
 * -$96,116.47. A checking month with zero expense rows is impossible, which is
 * how the batch is identified.
 *
 * This does NOT invent categories. It restores direction and then asks the
 * application's own `inferTransactionType` what each row is, so the result
 * matches what a correct import would have produced. Amounts are never touched:
 * they are stored as positive magnitudes and direction lives in the type.
 *
 * Every change is written to `transaction_audit_log` under one `bulk_action_id`,
 * so `revertBulkAction` can undo the whole repair from the Category Review UI.
 *
 * Dry run (default):  npx tsx scripts/repair-inverted-statement-types.ts
 * Apply:              npx tsx scripts/repair-inverted-statement-types.ts --apply
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import {
  inferTransactionType,
  normalizeDescription,
  SPEND_TYPES,
  SPEND_OFFSET_TYPES,
  type TransactionType,
} from '../lib/transactions'

const SOURCE_FILE = 'July_2026_Checking_Transactions_Clean.csv'
const ACTOR = 'v0-data-repair'
const APPLY = process.argv.includes('--apply')

/**
 * Types whose direction the bad import got wrong. `credit` was the bank's
 * "money in" label; `income` is what the sign fallback produced for unsigned
 * "money out" rows. Everything else in the batch (transfer/fee/payment) was
 * matched from the description before the sign was consulted, so it is already
 * right and is left alone.
 */
const INVERTED: Record<string, 1 | -1> = { credit: 1, income: -1 }

type Row = {
  id: string
  transaction_date: string | null
  description: string | null
  amount: number | string | null
  transaction_type: string
  review_status: string | null
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const money = (n: number) =>
  (n < 0 ? '-$' : '$') +
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Paginated read: PostgREST silently caps at 1,000 rows. */
async function fetchBatch(): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('financial_transactions')
      .select('id, transaction_date, description, amount, transaction_type, review_status')
      .eq('source_file_name', SOURCE_FILE)
      .is('deleted_at', null)
      .order('id')
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as Row[]))
    if ((data ?? []).length < 1000) break
  }
  return out
}

/** Net cash direction of a batch, using the app's own spend semantics. */
function summarize(rows: { type: string; amount: number }[]) {
  let inflow = 0
  let outflow = 0
  for (const r of rows) {
    const t = r.type as TransactionType
    if (t === 'income') inflow += r.amount
    else if (SPEND_TYPES.includes(t)) outflow += r.amount
    else if (SPEND_OFFSET_TYPES.includes(t)) outflow -= r.amount
  }
  return { inflow, outflow }
}

async function main() {
  const rows = await fetchBatch()
  if (rows.length === 0) {
    console.log(`No rows found for ${SOURCE_FILE}. Nothing to do.`)
    return
  }

  const before = summarize(
    rows.map((r) => ({ type: r.transaction_type, amount: Math.abs(Number(r.amount) || 0) })),
  )

  const changes: { row: Row; from: string; to: TransactionType }[] = []
  const after: { type: string; amount: number }[] = []

  for (const r of rows) {
    const amount = Math.abs(Number(r.amount) || 0)
    const direction = INVERTED[r.transaction_type]
    if (direction === undefined) {
      after.push({ type: r.transaction_type, amount })
      continue
    }
    const description = r.description ?? ''
    const resolved = inferTransactionType(
      normalizeDescription(description),
      direction * amount,
      description,
    )
    after.push({ type: resolved, amount })
    if (resolved !== r.transaction_type) {
      changes.push({ row: r, from: r.transaction_type, to: resolved })
    }
  }

  const post = summarize(after)

  console.log(`Batch: ${SOURCE_FILE}`)
  console.log(`Rows: ${rows.length}   Rows needing a type change: ${changes.length}`)
  console.log('')
  console.log('                    cash in        cash out')
  console.log(`  before   ${money(before.inflow).padStart(14)}  ${money(before.outflow).padStart(14)}`)
  console.log(`  after    ${money(post.inflow).padStart(14)}  ${money(post.outflow).padStart(14)}`)
  console.log('')

  const moves = new Map<string, { n: number; sum: number }>()
  for (const c of changes) {
    const k = `${c.from} -> ${c.to}`
    const b = moves.get(k) ?? { n: 0, sum: 0 }
    b.n++
    b.sum += Math.abs(Number(c.row.amount) || 0)
    moves.set(k, b)
  }
  console.log('--- type changes ---')
  for (const [k, v] of [...moves].sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`  ${k.padEnd(22)} ${String(v.n).padStart(3)} rows  ${money(v.sum).padStart(13)}`)
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.')
    return
  }
  if (changes.length === 0) {
    console.log('\nNothing to change.')
    return
  }

  const bulkActionId = randomUUID()
  const audit = changes.map((c) => ({
    transaction_id: c.row.id,
    field: 'transaction_type',
    previous_value: c.from,
    new_value: c.to,
    action: 'repair_inverted_statement_direction',
    bulk_action_id: bulkActionId,
    actor_email: ACTOR,
    reason:
      `Import read the statement's direction column as a transaction type, so this row's ` +
      `direction was inverted. Re-derived with inferTransactionType from the corrected ` +
      `direction (${INVERTED[c.from] === 1 ? 'money in' : 'money out'}). Source: ${SOURCE_FILE}.`,
  }))

  for (let i = 0; i < audit.length; i += 200) {
    const { error } = await db.from('transaction_audit_log').insert(audit.slice(i, i + 200))
    if (error) throw new Error(`audit insert failed: ${error.message}`)
  }

  // Group by target type so each distinct update is one statement.
  const byTarget = new Map<TransactionType, string[]>()
  for (const c of changes) {
    const list = byTarget.get(c.to) ?? []
    list.push(c.row.id)
    byTarget.set(c.to, list)
  }
  for (const [type, ids] of byTarget) {
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await db
        .from('financial_transactions')
        .update({ transaction_type: type })
        .in('id', ids.slice(i, i + 200))
      if (error) throw new Error(`update to ${type} failed: ${error.message}`)
    }
  }

  console.log(`\nAPPLIED. ${changes.length} rows retyped.`)
  console.log(`bulk_action_id = ${bulkActionId}  (undo restores every previous type)`)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
