import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const m = (n: any) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })

async function main() {
  // settings (key-value)
  const { data: sRows } = await db.from('business_settings').select('setting_key,value')
  const S: Record<string, number> = {}
  for (const r of sRows ?? []) S[r.setting_key] = Number(r.value)
  console.log('SETTINGS:', JSON.stringify(S))

  // cash accounts
  const { data: accts } = await db.from('bank_accounts').select('account_name,account_type,current_balance,credit_limit,last_updated')
  console.log('\nACCOUNTS:')
  let cashOnHand = 0, creditDrawn = 0, creditLimit = 0
  for (const a of accts ?? []) {
    const t = String(a.account_type).toLowerCase()
    console.log(' ', String(a.account_type).padEnd(14), String(a.account_name).padEnd(24), m(a.current_balance).padStart(10), 'upd', a.last_updated)
    if (t.includes('credit')) { creditDrawn += Math.abs(Number(a.current_balance) || 0); creditLimit += Number(a.credit_limit || 0) }
    else cashOnHand += Number(a.current_balance || 0)
  }
  console.log('cashOnHand(non-credit)=', m(cashOnHand))

  // obligations
  const { data: obl } = await db.from('cash_obligations').select('obligation_name,amount,frequency,status,active,due_date,next_due_date,category')
  let obl30 = 0, unscheduled = 0, debtService = 0
  const today = new Date('2026-08-01')
  for (const o of obl ?? []) {
    if (o.status === 'Paid' || o.active === false) continue
    const amt = Number(o.amount || 0)
    const cat = String(o.category ?? '').toLowerCase()
    if (cat.includes('loan') || cat.includes('debt')) { debtService += amt; continue }
    const due = o.due_date ?? o.next_due_date
    if (due) obl30 += amt
    else unscheduled += amt
  }
  console.log('\nobl30=', m(obl30), 'unscheduled=', m(unscheduled), 'debtService(approx)=', m(debtService))

  // loans table?
  for (const t of ['loans', 'debts']) {
    const { data, error } = await db.from(t).select('*').limit(3)
    if (!error) console.log(t, 'rows sample cols:', data?.[0] ? Object.keys(data[0]).join(',') : 'none')
  }

  // payroll avg (last 3 months with payroll) from financial_transactions
  const txns: any[] = []
  for (let p = 0; ; p++) {
    const { data } = await db.from('financial_transactions').select('transaction_date,amount,transaction_type,expense_category,review_status').range(p * 1000, p * 1000 + 999)
    txns.push(...(data ?? [])); if ((data ?? []).length < 1000) break
  }
  const payrollByMonth = new Map<string, number>()
  for (const t of txns) {
    if (t.review_status === 'excluded') continue
    if (!/^payroll/i.test(String(t.expense_category ?? ''))) continue
    const k = String(t.transaction_date).slice(0, 7)
    payrollByMonth.set(k, (payrollByMonth.get(k) ?? 0) + Math.abs(Number(t.amount) || 0))
  }
  const pm = [...payrollByMonth].filter(([, v]) => v > 0).sort().slice(-3)
  const payroll = pm.length ? pm.reduce((s, [, v]) => s + v, 0) / pm.length : 0
  console.log('payroll months:', pm.map(([k, v]) => `${k}:${m(v)}`).join(' '), '-> avg', m(payroll))

  // net cash flow over complete bank months (inflow>0)
  const IN = ['deposit','sale','income','credit','transfer_in','refund_received']
  const OUT = ['withdrawal','payment','expense','purchase','check','debit','fee','transfer_out','ach','card']
  const bm = new Map<string, { in: number; out: number }>()
  for (const t of txns) {
    if (t.review_status === 'excluded') continue
    const k = String(t.transaction_date).slice(0, 7); if (!/^\d{4}-\d{2}$/.test(k)) continue
    const e = bm.get(k) ?? { in: 0, out: 0 }; const amt = Math.abs(Number(t.amount) || 0); const tt = String(t.transaction_type).toLowerCase()
    if (IN.some(x => tt.includes(x))) e.in += amt; else if (OUT.some(x => tt.includes(x))) e.out += amt
    bm.set(k, e)
  }
  const complete = [...bm.values()].filter(b => b.in > 0)
  const netCF = complete.reduce((s, b) => s + (b.in - b.out), 0) / (complete.length || 1)
  console.log('netMonthlyCashFlow (complete months, n=' + complete.length + '):', m(netCF))

  // revenue trailing 12
  const { data: sales } = await db.from('sales_monthly').select('year,month_order,retail,wholesale')
  const rev = (sales ?? []).map(r => ({ k: `${r.year}-${String(r.month_order).padStart(2,'0')}`, v: Number(r.retail||0)+Number(r.wholesale||0) })).sort((a,b)=>a.k.localeCompare(b.k))
  const t12 = rev.slice(-12)
  const trailingRev = t12.reduce((s,r)=>s+r.v,0)/(t12.length||1)
  console.log('trailingMonthlyRevenue(12):', m(trailingRev))

  // receivables
  const { data: recv } = await db.from('accounts_receivable').select('amount,amount_paid,status,customer_name,invoice_number').limit(1000).then(r=>r).catch(()=>({data:[]} as any))
  let expReceiv = 0
  for (const r of recv ?? []) { if (r.status==='Paid') continue; const o=Number(r.amount||0)-Number(r.amount_paid||0); if (o>0 && r.customer_name && r.invoice_number) expReceiv+=o }
  console.log('expectedReceivables(approx):', m(expReceiv))

  // ---- SIMULATE ----
  const reserve = S.min_cash_reserve ?? 15000
  const baselinePct = S.marketing_baseline_pct ?? 1.5
  const ceilingPct = S.marketing_ceiling_pct ?? 3

  console.log('\n===== CURRENT (broken) =====')
  const totalDeduct = obl30 + unscheduled + payroll + debtService
  const projCurrent = cashOnHand + expReceiv - totalDeduct
  console.log('projectedCash =', m(projCurrent), '(cash + receiv - obl - payroll - debt)')
  console.log('availableOperatingCash =', m(projCurrent - reserve))
  const addlSafeCur = Math.max(0, projCurrent - reserve)
  console.log('additionalSafe =', m(addlSafeCur))

  console.log('\n===== FIXED (cash + expected net cash flow) =====')
  const projFixed = cashOnHand + netCF
  console.log('projectedCash =', m(projFixed), '(cash + expected net cash flow)')
  const avail = projFixed - reserve
  console.log('availableOperatingCash =', m(avail))
  const addlSafe = Math.max(0, avail)
  const baseline = trailingRev * baselinePct / 100
  const ceiling = trailingRev * ceilingPct / 100
  console.log('marketing baseline (', baselinePct, '% of rev) =', m(baseline), '| ceiling(', ceilingPct, '%)=', m(ceiling))
  const reserveCoverage = projFixed / reserve
  let adjusted = baseline
  if (reserveCoverage < 1) adjusted *= 0.25
  else if (reserveCoverage < 1.25) adjusted *= 0.6
  else if (reserveCoverage > 2) adjusted *= 1.15
  // seasonal weak (August ~ -34%)
  adjusted *= 0.85
  let recommended = Math.min(adjusted, ceiling)
  let boundBy = 'none'
  if (recommended > addlSafe) { recommended = addlSafe; boundBy = 'affordability' }
  console.log('reserveCoverage=', reserveCoverage.toFixed(2), 'adjusted=', m(adjusted), 'recommended=', m(Math.max(0,recommended)), 'boundBy=', boundBy)
}
main()
