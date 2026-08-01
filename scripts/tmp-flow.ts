import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const m = (n: any) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })

const IN = ['deposit', 'sale', 'income', 'credit', 'transfer_in', 'refund_received']
const OUT = ['withdrawal', 'payment', 'expense', 'purchase', 'check', 'debit', 'fee', 'transfer_out', 'ach', 'card']

async function main() {
  // Bank transactions -> monthly inflow/outflow/net
  const txns: any[] = []
  for (let p = 0; ; p++) {
    const { data, error } = await db.from('financial_transactions')
      .select('transaction_date,amount,transaction_type,review_status,account_name')
      .range(p * 1000, p * 1000 + 999)
    if (error) { console.log('ERR', error.message); break }
    txns.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  const byMonth = new Map<string, { in: number; out: number; other: number; n: number }>()
  for (const t of txns) {
    if (t.review_status === 'excluded') continue
    const k = String(t.transaction_date ?? '').slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(k)) continue
    const e = byMonth.get(k) ?? { in: 0, out: 0, other: 0, n: 0 }
    const amt = Math.abs(Number(t.amount) || 0)
    const tt = String(t.transaction_type ?? '').toLowerCase()
    if (IN.some((x) => tt.includes(x))) e.in += amt
    else if (OUT.some((x) => tt.includes(x))) e.out += amt
    else e.other += amt
    e.n++
    byMonth.set(k, e)
  }

  // Sales revenue
  const { data: sales } = await db.from('sales_monthly').select('year,month_order,retail,wholesale,source')
  const rev = new Map<string, number>()
  for (const r of sales ?? []) rev.set(`${r.year}-${String(r.month_order).padStart(2, '0')}`, Number(r.retail || 0) + Number(r.wholesale || 0))

  console.log('month    bank_in     bank_out    bank_net    sales_rev   inflow≈rev?')
  const keys = [...new Set([...byMonth.keys(), ...rev.keys()])].sort()
  for (const k of keys) {
    const b = byMonth.get(k) ?? { in: 0, out: 0, other: 0, n: 0 }
    const r = rev.get(k) ?? 0
    const complete = b.in > 0
    console.log(
      k,
      m(b.in).padStart(11), m(b.out).padStart(11),
      m(b.in - b.out).padStart(11), m(r).padStart(11),
      complete ? (b.in > 0 && r > 0 ? (b.in / r).toFixed(2) + 'x' : '') : ' INCOMPLETE',
    )
  }
  // Net cash flow over complete bank months
  const complete = [...byMonth.entries()].filter(([, b]) => b.in > 0)
  const net = complete.reduce((s, [, b]) => s + (b.in - b.out), 0) / (complete.length || 1)
  console.log('\ncomplete bank months:', complete.length)
  console.log('avg net cash flow (bank):', m(net))
  console.log('latest bank month:', keys.filter((k) => (byMonth.get(k)?.in ?? 0) > 0).pop())
}
main()
