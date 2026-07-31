import { createClient } from '@supabase/supabase-js'

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
})
const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function main() {
  const { data: sales } = await db.from('sales_monthly').select('*').order('year').order('month_order')

  console.log('=== does Square data ALSO exist for the "calculated" months? ===')
  console.log('month    source        retail        square_net    square_gross  sq_txns')
  for (const s of sales ?? []) {
    const key = `${s.year}-${String(s.month_order).padStart(2, '0')}`
    console.log(
      `${key}  ${String(s.source ?? '?').padEnd(12)} ${money(Number(s.retail ?? 0)).padStart(12)} ` +
        `${(s.square_net_sales == null ? '(none)' : money(Number(s.square_net_sales))).padStart(13)} ` +
        `${(s.square_gross_sales == null ? '(none)' : money(Number(s.square_gross_sales))).padStart(13)} ` +
        `${s.square_transaction_count ?? '-'}`,
    )
  }

  // Do the bank-payout months equal the retail figure exactly? (substitution test)
  const { data: sd } = await db
    .from('financial_transactions')
    .select('transaction_date, amount')
    .eq('expense_category', 'Sales Deposit')
    .eq('transaction_type', 'income')
  const byMonth = new Map<string, number>()
  for (const r of sd ?? []) {
    const m = String(r.transaction_date).slice(0, 7)
    byMonth.set(m, (byMonth.get(m) ?? 0) + Number(r.amount))
  }
  console.log('\n=== bank payouts vs stored retail, per month ===')
  for (const [m, amt] of [...byMonth.entries()].sort()) {
    const [y, mo] = m.split('-')
    const row = (sales ?? []).find((s) => String(s.year) === y && String(s.month_order) === String(Number(mo)))
    const retail = Number(row?.retail ?? 0)
    const same = Math.abs(retail - amt) < 0.01
    console.log(
      `   ${m} bank=${money(amt).padStart(12)} retail=${money(retail).padStart(12)} ${same ? 'IDENTICAL -> retail IS the bank figure' : 'differs'} src=${row?.source ?? '?'}`,
    )
  }
}
main()
