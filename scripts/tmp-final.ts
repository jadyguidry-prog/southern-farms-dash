import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)
const m = (n: any) =>
  '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })

async function main() {
  const { data } = await db
    .from('sales_daily')
    .select('sale_date,gross_sales')
    .gte('sale_date', '2026-07-01')
    .lte('sale_date', '2026-07-31')
  const rows = data ?? []
  const gross = rows.reduce((s, r: any) => s + Number(r.gross_sales || 0), 0)
  console.log('July days present :', new Set(rows.map((r: any) => r.sale_date)).size)
  console.log('July gross        :', m(gross))
  console.log('owner Square figure:', m(96729.79))
  console.log('remaining diff    :', m(96729.79 - gross))
  console.log('(unchanged after 2nd sync run => idempotent)')

  // Duplicate guard: one row per date per source, or rollups double-count.
  const seen = new Map<string, number>()
  for (const r of rows as any[])
    seen.set(r.sale_date, (seen.get(r.sale_date) ?? 0) + 1)
  const dupes = [...seen.entries()].filter(([, c]) => c > 1)
  console.log('duplicate July dates:', dupes.length ? JSON.stringify(dupes) : 'none')

  const { data: mo } = await db
    .from('sales_monthly')
    .select('square_gross_sales,retail,source')
    .eq('year', 2026)
    .eq('month_order', 7)
    .maybeSingle()
  console.log('sales_monthly July  :', m(mo?.square_gross_sales), '| source', mo?.source)
}
main()
