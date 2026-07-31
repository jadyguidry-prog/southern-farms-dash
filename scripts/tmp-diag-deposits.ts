/**
 * TEMPORARY diagnostic. Deleted before handover.
 * Runs the evidence engine against the owner's real Sales Deposit rows.
 */
import { createClient } from '@supabase/supabase-js'
import { assessReclassification } from '../lib/reclassify-evidence'

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
})

async function main() {
  const { data } = await db
    .from('financial_transactions')
    .select('amount, transaction_date, transaction_type')
    .eq('expense_category', 'Sales Deposit')
    .is('deleted_at', null)

  const spend = (data ?? []).filter((r) => r.transaction_type === 'expense')
  const income = (data ?? []).filter((r) => r.transaction_type === 'income')

  for (const [label, rows] of [
    ['THE 47 EXPENSE ROWS (what the button targets)', spend],
    ['THE 231 INCOME ROWS (for contrast)', income],
  ] as const) {
    const rep = assessReclassification(
      rows.map((r) => ({
        amount: Number(r.amount),
        direction: r.transaction_type === 'income' ? ('in' as const) : ('out' as const),
        date: String(r.transaction_date),
      })),
    )
    console.log(`\n=== ${label} ===`)
    console.log('verdict:', rep.verdict, '| blocks reclassification:', rep.blocksReclassification)
    console.log('rows:', rep.rowCount, '| months:', rep.monthCount, '| avg: $' + rep.averageAmount)
    console.log('outflow share:', rep.outflowShare, '| early-month share:', rep.earlyMonthShare)
    console.log('recurring:', JSON.stringify(rep.recurringAmounts.slice(0, 4)))
    for (const r of rep.reasons) console.log('  -', r)
  }
}
main()
