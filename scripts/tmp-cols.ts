import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
async function main() {
  const { data } = await sb.from('sales_monthly').select('*').limit(1)
  console.log('sales_monthly columns:\n ', Object.keys(data?.[0] ?? {}).join('\n  '))
}
main()
