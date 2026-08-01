/**
 * Fill in categories for recent spend where the owner's OWN history already
 * answers the question unanimously.
 *
 * Why this exists: repairing the inverted July import set each row's
 * `transaction_type` correctly but left `expense_category` blank, so July showed
 * ~$82k of uncategorized spend. Most of it is not ambiguous at all — Quirch
 * Foods has been filed as Meat / COGS 42 times out of 42, IRS as Payroll Taxes
 * 39 of 39. Re-typing those by hand would be busywork.
 *
 * The rule is deliberately strict: a category is applied ONLY when every
 * categorized historical row for that payee agrees. Any disagreement, however
 * small, means the row is left for the owner. Nothing is guessed.
 *
 * Dry run by default. Pass --apply to write. Writes a `bulk_action_id` audit
 * trail in the same shape as `categorizeTransactions`, so the whole batch can be
 * undone from Category Review.
 *
 *   npx tsx scripts/apply-unanimous-categories.ts
 *   npx tsx scripts/apply-unanimous-categories.ts --apply
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { payeeKeyOf, isGenericDescription } from '../lib/transaction-groups'
import { normalizeDescription, SPEND_TYPES } from '../lib/transactions'
import { presentWindowStart } from '../lib/cash-flow-service'

const APPLY = process.argv.includes('--apply')
const PAGE = 1000

type Row = {
  id: string
  transaction_date: string
  description: string | null
  normalized_description: string | null
  amount: number | string
  transaction_type: string
  expense_category: string | null
  review_status: string | null
}

const money = (n: number) =>
  '$' + Math.round(n).toLocaleString('en-US')

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing.')
  return createClient(url, key)
}

/** Paginated read — PostgREST silently caps at 1000 rows. */
async function fetchAll(client: ReturnType<typeof db>): Promise<Row[]> {
  const out: Row[] = []
  for (let page = 0; ; page += 1) {
    const { data, error } = await client
      .from('financial_transactions')
      .select(
        'id, transaction_date, description, normalized_description, amount, transaction_type, expense_category, review_status',
      )
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Row[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

const keyOf = (r: Row) =>
  payeeKeyOf(r.normalized_description || normalizeDescription(r.description ?? ''))

async function main() {
  const client = db()
  const rows = await fetchAll(client)
  const spend = new Set<string>(SPEND_TYPES)
  const windowStart = presentWindowStart(new Date().toISOString().slice(0, 10))

  console.log(`Loaded ${rows.length} transactions.`)
  console.log(`Present window starts ${windowStart}.\n`)

  // Historical votes come from rows BEFORE the window, so we never learn a
  // category from the very rows we are about to write.
  const votes = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (r.transaction_date.slice(0, 10) >= windowStart) continue
    const category = (r.expense_category ?? '').trim()
    if (!category) continue
    const k = keyOf(r)
    const tally = votes.get(k) ?? new Map<string, number>()
    tally.set(category, (tally.get(category) ?? 0) + 1)
    votes.set(k, tally)
  }

  const targets = rows.filter(
    (r) =>
      r.transaction_date.slice(0, 10) >= windowStart &&
      spend.has(r.transaction_type) &&
      !(r.expense_category ?? '').trim(),
  )

  const planned: { row: Row; category: string; votes: number }[] = []
  const skipped: { row: Row; why: string }[] = []

  for (const r of targets) {
    const normalized =
      r.normalized_description || normalizeDescription(r.description ?? '')

    // A statement line with no payee on it can never be attributed by rule.
    if (isGenericDescription(normalized)) {
      skipped.push({ row: r, why: 'no payee on the statement' })
      continue
    }

    const tally = votes.get(keyOf(r))
    if (!tally || tally.size === 0) {
      skipped.push({ row: r, why: 'no history for this payee' })
      continue
    }
    if (tally.size > 1) {
      const spread = [...tally]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c}:${n}`)
        .join(', ')
      skipped.push({ row: r, why: `history disagrees (${spread})` })
      continue
    }

    const [[category, count]] = [...tally]
    planned.push({ row: r, category, votes: count })
  }

  const byCategory = new Map<string, { n: number; sum: number; payees: Set<string> }>()
  for (const p of planned) {
    const b =
      byCategory.get(p.category) ?? { n: 0, sum: 0, payees: new Set<string>() }
    b.n += 1
    b.sum += Math.abs(Number(p.row.amount))
    b.payees.add(keyOf(p.row))
    byCategory.set(p.category, b)
  }

  console.log(`Uncategorized spend rows in window: ${targets.length}`)
  console.log(`  unanimous match -> will set: ${planned.length}`)
  console.log(`  left for review:             ${skipped.length}\n`)

  console.log('--- planned categories ---')
  for (const [category, b] of [...byCategory].sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(
      `  ${String(b.n).padStart(3)} rows  ${money(b.sum).padStart(10)}  -> ${category}   (${b.payees.size} payee(s))`,
    )
  }

  const skipReasons = new Map<string, { n: number; sum: number }>()
  for (const s of skipped) {
    const b = skipReasons.get(s.why) ?? { n: 0, sum: 0 }
    b.n += 1
    b.sum += Math.abs(Number(s.row.amount))
    skipReasons.set(s.why, b)
  }
  console.log('\n--- left for your review ---')
  for (const [why, b] of [...skipReasons].sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`  ${String(b.n).padStart(3)} rows  ${money(b.sum).padStart(10)}  ${why}`)
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to write.')
    return
  }
  if (planned.length === 0) {
    console.log('\nNothing to apply.')
    return
  }

  const bulkActionId = randomUUID()
  const actor = 'script:apply-unanimous-categories'

  // Group by category so each update is one call per category, and the audit
  // reason can name the category being applied.
  const groups = new Map<string, typeof planned>()
  for (const p of planned) {
    groups.set(p.category, [...(groups.get(p.category) ?? []), p])
  }

  for (const [category, items] of groups) {
    const reason = `Filed ${items.length} uncategorized row(s) as "${category}" — every categorized historical row for these payees agreed.`

    const audit = items.flatMap((p) => [
      {
        transaction_id: p.row.id,
        field: 'expense_category',
        previous_value: String(p.row.expense_category ?? ''),
        new_value: category,
        action: 'categorize_payee',
        bulk_action_id: bulkActionId,
        actor_email: actor,
        reason,
      },
      {
        transaction_id: p.row.id,
        field: 'review_status',
        previous_value: String(p.row.review_status ?? ''),
        new_value: 'matched',
        action: 'categorize_payee',
        bulk_action_id: bulkActionId,
        actor_email: actor,
        reason: 'Marked reviewed alongside the category assignment.',
      },
    ])

    for (let i = 0; i < audit.length; i += 200) {
      const { error } = await client
        .from('transaction_audit_log')
        .insert(audit.slice(i, i + 200))
      if (error) throw new Error(`audit: ${error.message}`)
    }

    const ids = items.map((p) => p.row.id)
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await client
        .from('financial_transactions')
        .update({ expense_category: category, review_status: 'matched' })
        .in('id', ids.slice(i, i + 200))
      if (error) throw new Error(`update: ${error.message}`)
    }

    console.log(`  applied ${items.length} -> ${category}`)
  }

  console.log(`\nApplied ${planned.length} row(s).`)
  console.log(`bulk_action_id: ${bulkActionId}  (undo from Category Review)`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
