/**
 * Retype card/loan payoffs that were imported as vendor spend.
 *
 * A payoff moves money from checking to a card or loan account. It is not vendor
 * spend, and both AMEX card statements are separately imported — so counting the
 * payoff as an expense counts the same money twice: once as the purchase on the
 * card, once as the payment from the bank.
 *
 * Decides using `looksLikeAccountPayoff` from lib/transactions rather than its
 * own copy of the rules, so this script and the importer can never disagree.
 *
 * Dry run by default. Pass --apply to write. Idempotent: rows already typed
 * `payment` are skipped, so re-running is safe.
 *
 *   npx tsx scripts/fix-mistyped-account-payoffs.ts
 *   npx tsx scripts/fix-mistyped-account-payoffs.ts --apply
 */

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { fetchAllPages } from '../lib/paginate'
import { looksLikeAccountPayoff, SPEND_TYPES } from '../lib/transactions'

const APPLY = process.argv.includes('--apply')
const ACTOR = 'sf.specialtymeats@gmail.com'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type Row = {
  id: string
  transaction_date: string | null
  description: string | null
  amount: number | null
  transaction_type: string | null
  expense_category: string | null
  account_name: string | null
}

async function main() {
  const rows = await fetchAllPages<Row>(
    (from, to) =>
      sb
        .from('financial_transactions')
        .select(
          'id, transaction_date, description, amount, transaction_type, expense_category, account_name',
        )
        .is('deleted_at', null)
        .range(from, to),
    'mistyped payoff scan',
  )

  // Only rows that currently COUNT AS SPEND and look like a payoff.
  const targets = rows.filter(
    (r) =>
      SPEND_TYPES.includes((r.transaction_type ?? '') as never) &&
      looksLikeAccountPayoff(String(r.description ?? '')),
  )

  if (targets.length === 0) {
    console.log('Nothing to do — no spend-typed rows look like account payoffs.')
    return
  }

  const total = targets.reduce((s, r) => s + Number(r.amount ?? 0), 0)

  // Group for a readable summary.
  const groups = new Map<string, { n: number; t: number }>()
  for (const r of targets) {
    const k = String(r.description ?? '').replace(/\s*[A-Z]?\d{3,}\s*$/i, '').trim()
    const e = groups.get(k) ?? { n: 0, t: 0 }
    e.n++
    e.t += Number(r.amount ?? 0)
    groups.set(k, e)
  }

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${targets.length} rows, $${total.toFixed(2)}\n`)
  for (const [k, v] of [...groups].sort((a, b) => b[1].t - a[1].t)) {
    console.log(`  ${String(v.n).padStart(3)} rows  $${v.t.toFixed(2).padStart(11)}  ${k}`)
  }

  // Show the money effect, which is the whole point of the change.
  console.log(`\n  These rows currently inflate vendor spend by $${total.toFixed(2)}.`)
  console.log('  After retyping to "payment" they are excluded from spend totals')
  console.log('  (SPEND_TYPES = expense, fee, interest) but remain visible as cash movement.')

  if (!APPLY) {
    console.log('\nRe-run with --apply to write these changes.')
    return
  }

  const bulkId = randomUUID()
  const reason =
    `Retyped ${targets.length} row(s) from vendor spend to "payment": card/loan account ` +
    `payoffs, not purchases. The underlying purchases are already imported from the ` +
    `card statements, so counting these as spend double-counted $${total.toFixed(2)}.`

  let changed = 0
  for (const r of targets) {
    const { error: upErr } = await sb
      .from('financial_transactions')
      .update({ transaction_type: 'payment' })
      .eq('id', r.id)
    if (upErr) {
      console.log(`  ERROR updating ${r.id}: ${upErr.message}`)
      continue
    }
    const { error: logErr } = await sb.from('transaction_audit_log').insert({
      transaction_id: r.id,
      field: 'transaction_type',
      previous_value: r.transaction_type,
      new_value: 'payment',
      action: 'retype_account_payoff',
      bulk_action_id: bulkId,
      actor_email: ACTOR,
      reason,
    })
    if (logErr) console.log(`  WARN audit log failed for ${r.id}: ${logErr.message}`)
    changed++
  }

  console.log(`\nRetyped ${changed} row(s). Undo id: ${bulkId}`)
  console.log('Reversible from Category Review → Recent changes.')
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
