import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
;(async () => {
  const { data } = await db.from('financial_transactions')
    .select('description, amount, transaction_type, expense_category')
    .eq('expense_category', 'Sales Deposit').is('deleted_at', null).limit(60)
  const counts = new Map<string, number>()
  for (const r of data ?? []) counts.set(r.description, (counts.get(r.description) ?? 0) + 1)
  console.log('distinct descriptions:', counts.size, 'of', data?.length)
  ;[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,14).forEach(([d,c]) => console.log(String(c).padStart(3), JSON.stringify(d)))
})()
