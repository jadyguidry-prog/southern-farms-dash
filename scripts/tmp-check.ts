import { createClient } from '@supabase/supabase-js'
import { fetchAllPages } from '../lib/paginate'
import { SPEND_TYPES } from '../lib/transactions'
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
async function main() {
  const rows = await fetchAllPages<any>((f,t)=>sb.from('financial_transactions')
    .select('description, amount, transaction_type, expense_category, review_status')
    .is('deleted_at',null).range(f,t),'v')
  const spend = rows.filter(r=>SPEND_TYPES.includes(r.transaction_type) && r.review_status!=='excluded')
  const uncat = spend.filter(r=>!r.expense_category)
  console.log('spend total now : $' + spend.reduce((s,r)=>s+Number(r.amount??0),0).toFixed(2))
  console.log('uncategorized   : ' + uncat.length + ' rows $' + uncat.reduce((s,r)=>s+Number(r.amount??0),0).toFixed(2))
  const amex = rows.filter(r=>/epayment|loan payment/i.test(String(r.description??'')))
  console.log('\nthe 18 rows now typed:', [...new Set(amex.map(r=>r.transaction_type))])
  console.log('still counted as spend?', amex.some(r=>SPEND_TYPES.includes(r.transaction_type)) ? 'YES (BAD)' : 'no')
}
main()
