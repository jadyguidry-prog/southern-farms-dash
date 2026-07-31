import { createClient } from '@supabase/supabase-js'

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
})
const money = (n: number) => '$' + n.toFixed(2)

async function main() {
  const { data: rules } = await db.from('sales_source_rules').select('*').order('priority')
  console.log('=== sales_source_rules ===')
  for (const r of rules ?? [])
    console.log(`   [${r.priority}] ${r.match_type} ${JSON.stringify(r.match_text)} -> ${r.channel} active=${r.active}`)

  const { data: sd } = await db
    .from('financial_transactions')
    .select('normalized_description, amount, transaction_type, expense_category')
    .eq('expense_category', 'Sales Deposit')
    .eq('transaction_type', 'income')

  // Replicate the classifier's matching to see where these land.
  const active = (rules ?? []).filter((r) => r.active)
  function classify(desc: string): string {
    const d = (desc ?? '').toLowerCase()
    for (const r of active) {
      const m = String(r.match_text).toLowerCase()
      const hit =
        r.match_type === 'exact' ? d === m : r.match_type === 'starts_with' ? d.startsWith(m) : d.includes(m)
      if (hit) return r.channel
    }
    return '(unclassified)'
  }
  const out = new Map<string, { n: number; amt: number }>()
  for (const r of sd ?? []) {
    const c = classify(String(r.normalized_description))
    const e = out.get(c) ?? { n: 0, amt: 0 }
    e.n++
    e.amt += Number(r.amount)
    out.set(c, e)
  }
  console.log('\n=== where the 231 Square bank payouts land in sales classification ===')
  for (const [c, e] of out) console.log(`   ${c}: n=${e.n} ${money(e.amt)}`)

  console.log('\nsample normalized_description:', (sd ?? []).slice(0, 3).map((r) => r.normalized_description))

  // What does the stored sales table say vs Square?
  const { data: sales } = await db.from('sales_monthly').select('*')
  console.log('\n=== sales_monthly stored rows ===', sales?.length ?? 0)
  let tot = 0
  for (const s of sales ?? []) tot += Number(s.retail ?? 0) + Number(s.wholesale ?? 0)
  console.log('stored sales total:', money(tot))
}
main()
