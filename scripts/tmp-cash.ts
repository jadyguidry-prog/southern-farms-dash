import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const m = (n: any) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function main() {
  // How current is the bank/expense data?
  const { data: mx } = await db.from('financial_transactions').select('transaction_date').is('deleted_at', null).order('transaction_date', { ascending: false }).limit(1)
  const { data: mn } = await db.from('financial_transactions').select('transaction_date').is('deleted_at', null).order('transaction_date', { ascending: true }).limit(1)
  console.log('financial_transactions date range:', mn?.[0]?.transaction_date, '->', mx?.[0]?.transaction_date)

  // per-month expense volume, last 10 months, to see where data thins out
  const { data: rows } = await db.from('financial_transactions').select('transaction_date,amount,transaction_type').is('deleted_at', null).gte('transaction_date', '2025-10-01')
  const byM = new Map<string, { n: number; exp: number; inc: number }>()
  for (const r of rows ?? []) {
    const k = String(r.transaction_date).slice(0, 7)
    const e = byM.get(k) ?? { n: 0, exp: 0, inc: 0 }
    e.n++
    if (r.transaction_type === 'expense') e.exp += Math.abs(Number(r.amount || 0)); else e.inc += Math.abs(Number(r.amount || 0))
    byM.set(k, e)
  }
  console.log('\nmonth   rows      expenses        income')
  for (const k of [...byM.keys()].sort()) { const v = byM.get(k)!; console.log(' ', k, String(v.n).padStart(5), m(v.exp).padStart(14), m(v.inc).padStart(14)) }

  console.log('\n=== cash_obligations ===')
  const { data: ob, error: obe } = await db.from('cash_obligations').select('*')
  if (obe) console.log('ERR', obe.message)
  else {
    console.log('columns:', ob?.[0] ? Object.keys(ob[0]).join(', ') : 'none')
    let t = 0
    for (const o of ob ?? []) {
      t += Number(o.amount || 0)
      console.log('  ', String(o.name ?? o.label ?? o.description ?? '?').slice(0, 34).padEnd(36), m(o.amount).padStart(12), '| due:', o.due_day ?? o.due_date ?? '(NONE)', '| active:', o.is_active ?? o.active ?? '?')
    }
    console.log('  TOTAL obligations:', m(t))
  }

  // cash balance source
  for (const t of ['bank_accounts', 'account_balances', 'cash_position', 'business_health_metrics']) {
    const { data, error } = await db.from(t).select('*').limit(3)
    if (!error) console.log(`\n=== ${t} (${data?.length} rows) ===`, data?.[0] ? Object.keys(data[0]).join(', ') : '', '\n', JSON.stringify(data)?.slice(0, 500))
  }

  // revenue reality check
  const { data: sm } = await db.from('sales_monthly').select('year,month_order,retail,wholesale,calculated_retail,calculated_wholesale').order('year').order('month_order')
  console.log('\n=== sales_monthly last 14 ===')
  for (const r of (sm ?? []).slice(-14)) {
    const rev = Number(r.retail ?? r.calculated_retail ?? 0) + Number(r.wholesale ?? r.calculated_wholesale ?? 0)
    console.log('  ', r.year, String(r.month_order).padStart(2), m(rev).padStart(14))
  }
}
main().catch((e) => console.log('FAILED:', e.message))
