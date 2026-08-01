import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const m = (n: any) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const MKT = /facebook|fb ads|meta|google|adwords|instagram|mailchimp|constant contact|vistaprint|canva|yelp|advertis|market|promo|billboard|radio|print|signs|flyer|banner|klaviyo|hootsuite/i

async function main() {
  const txns: any[] = []
  for (let p = 0; ; p++) {
    const { data } = await db.from('financial_transactions')
      .select('id,transaction_date,description,amount,transaction_type,expense_category,vendor_id,review_status')
      .range(p * 1000, p * 1000 + 999)
    txns.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  const { data: vendors } = await db.from('vendors').select('id,vendor_name,category')
  const mktVendors = new Set((vendors ?? []).filter((v) => String(v.category) === 'Marketing').map((v) => String(v.id)))
  console.log('vendors flagged Marketing:', mktVendors.size)

  // Categorized-as-marketing, by month (calendar)
  const catByMonth = new Map<string, number>()
  const uncatByMonth = new Map<string, number>()
  const uncatRows: any[] = []
  for (const t of txns) {
    if (t.review_status === 'excluded') continue
    const amt = Math.abs(Number(t.amount) || 0)
    if (amt === 0) continue
    const k = String(t.transaction_date ?? '').slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(k)) continue
    const cat = String(t.expense_category ?? '').trim()
    const isMktCat = cat === 'Marketing'
    const isMktVendor = t.vendor_id && mktVendors.has(String(t.vendor_id))
    if (isMktCat || isMktVendor) {
      catByMonth.set(k, (catByMonth.get(k) ?? 0) + amt)
    } else if (cat === '' && MKT.test(String(t.description ?? ''))) {
      uncatByMonth.set(k, (uncatByMonth.get(k) ?? 0) + amt)
      uncatRows.push(t)
    }
  }
  const catTotal = [...catByMonth.values()].reduce((s, v) => s + v, 0)
  const catMonths = [...catByMonth.keys()].sort()
  console.log('\n=== CATEGORIZED marketing by month ===')
  for (const k of catMonths) console.log(' ', k, m(catByMonth.get(k)))
  console.log('categorized total:', m(catTotal), 'over', catMonths.length, 'active months')
  console.log('span first->last:', catMonths[0], '->', catMonths.at(-1))
  // calendar-month averages
  const span = catMonths.length > 1 ? (12 * (Number(catMonths.at(-1)!.slice(0,4)) - Number(catMonths[0].slice(0,4))) + (Number(catMonths.at(-1)!.slice(5)) - Number(catMonths[0].slice(5))) + 1) : 1
  console.log('calendar months in span:', span, '-> avg/mo:', m(catTotal / span))
  console.log('avg over ACTIVE months only:', m(catTotal / (catMonths.length || 1)))

  console.log('\n=== UNCATEGORIZED suspected-marketing ===')
  const uncatTotal = [...uncatByMonth.values()].reduce((s, v) => s + v, 0)
  console.log('total:', m(uncatTotal), 'rows:', uncatRows.length)
  for (const t of uncatRows.sort((a,b)=>String(b.transaction_date).localeCompare(String(a.transaction_date))).slice(0, 25))
    console.log(' ', String(t.transaction_date).slice(0,10), m(Math.abs(t.amount)).padStart(11), (t.description||'').slice(0,50))
}
main()
