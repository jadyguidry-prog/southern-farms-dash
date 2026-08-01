import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const m = (n: any) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function all(table: string, cols: string) {
  const out: any[] = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from(table).select(cols).is('deleted_at', null).order('id').range(f, f + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}

async function main() {
  const rows = await all('financial_transactions', 'transaction_date,description,amount,transaction_type,expense_category,vendor_id,review_status')
  console.log('total financial_transactions:', rows.length)
  const exp = rows.filter((r) => r.transaction_type === 'expense')
  console.log('expense rows:', exp.length)

  const PAT = /FACEBOOK|META|GOOGLE|ADWORD|INSTAGRAM|YELP|MAILCHIMP|CONSTANT ?CONTACT|CANVA|WIX|SQUARESPACE|GODADDY|RADIO|BILLBOARD|ADVERT|MARKET|SPONSOR|PROMO|FLYER|BROCHUR|WEBSITE|SEO|VISTAPRINT|HOOTSUITE|BOOST|SIGN|PRINT|BANNER|MAGAZINE|NEWSPAPER|MEDIA|DESIGN/i

  // Marketing by CATEGORY, per calendar month, last 18 months
  console.log('\n=== rows whose expense_category is Marketing, by month ===')
  const mkt = exp.filter((r) => /market/i.test(r.expense_category || ''))
  const byMonth = new Map<string, { n: number; amt: number }>()
  for (const r of mkt) {
    const k = String(r.transaction_date).slice(0, 7)
    const e = byMonth.get(k) ?? { n: 0, amt: 0 }
    e.n++; e.amt += Math.abs(Number(r.amount || 0)); byMonth.set(k, e)
  }
  for (const k of [...byMonth.keys()].sort().slice(-18)) {
    const v = byMonth.get(k)!
    console.log('  ', k, String(v.n).padStart(4), 'txns', m(v.amt).padStart(13))
  }
  console.log('  TOTAL categorized Marketing (all time):', m(mkt.reduce((s, r) => s + Math.abs(Number(r.amount || 0)), 0)))
  console.log('  distinct descriptions:')
  const d1 = new Map<string, number>()
  for (const r of mkt) d1.set((r.description || '').slice(0, 44), (d1.get((r.description || '').slice(0, 44)) ?? 0) + Math.abs(Number(r.amount || 0)))
  for (const [k, v] of [...d1.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log('    ', k.padEnd(46), m(v))

  // Rows that LOOK like marketing but are NOT categorized as marketing
  const missed = exp.filter((r) => !/market/i.test(r.expense_category || '') && PAT.test(r.description || ''))
  console.log('\n=== LOOKS like marketing but NOT categorized Marketing ===')
  console.log('count:', missed.length, ' total:', m(missed.reduce((s, r) => s + Math.abs(Number(r.amount || 0)), 0)))
  const d2 = new Map<string, { n: number; amt: number; cat: string }>()
  for (const r of missed) {
    const k = (r.description || '').slice(0, 44)
    const e = d2.get(k) ?? { n: 0, amt: 0, cat: r.expense_category || '(EMPTY)' }
    e.n++; e.amt += Math.abs(Number(r.amount || 0)); d2.set(k, e)
  }
  for (const [k, v] of [...d2.entries()].sort((a, b) => b[1].amt - a[1].amt).slice(0, 30))
    console.log('  ', k.padEnd(46), String(v.n).padStart(4), m(v.amt).padStart(12), '| cat:', v.cat)

  // Uncategorized overall
  const unc = exp.filter((r) => !r.expense_category || !String(r.expense_category).trim() || /uncategor|unknown|other/i.test(r.expense_category))
  console.log('\n=== uncategorized / other expense rows ===')
  console.log('count:', unc.length, 'total:', m(unc.reduce((s, r) => s + Math.abs(Number(r.amount || 0)), 0)))
  const recent = unc.filter((r) => String(r.transaction_date) >= '2026-07-01')
  console.log('since Jul 1 2026:', recent.length, m(recent.reduce((s, r) => s + Math.abs(Number(r.amount || 0)), 0)))
  for (const r of recent.slice(0, 25)) console.log('   ', r.transaction_date, m(Math.abs(r.amount)).padStart(11), (r.description || '').slice(0, 50), '| cat:', r.expense_category || '(EMPTY)')
}
main().catch((e) => console.log('FAILED:', e.message))
