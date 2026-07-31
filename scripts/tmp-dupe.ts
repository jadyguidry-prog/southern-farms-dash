import { createClient } from '@supabase/supabase-js'
import { asSalesDataSource } from '../lib/sales-source'
import {
  aggregateDailyRetailByMonth,
  auditSalesSources,
  monthKey,
  type MonthAuditInput,
} from '../lib/sales-source-audit'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

function money(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

async function main() {
  const { data: monthly } = await sb
    .from('sales_monthly')
    .select('year, month, retail, source, locked')
  const daily: any[] = []
  for (let p = 0; ; p += 1) {
    const { data } = await sb
      .from('sales_daily')
      .select('sale_date, source, retail_sales')
      .range(p * 1000, p * 1000 + 999)
    daily.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }

  const squareByMonth = aggregateDailyRetailByMonth(daily)
  const inputs: MonthAuditInput[] = []
  let skipped = 0
  for (const row of monthly ?? []) {
    const mk = monthKey(Number(row.year), String(row.month ?? ''))
    if (!mk) {
      skipped += 1
      continue
    }
    inputs.push({
      month: mk,
      reportedRetail: row.retail == null ? null : Number(row.retail),
      reportedSource: asSalesDataSource(row.source),
      squareDailyRetail: squareByMonth.has(mk) ? squareByMonth.get(mk)! : null,
      locked: Boolean(row.locked),
    })
  }
  console.log(`months read: ${inputs.length}, unparseable skipped: ${skipped}`)

  const audit = auditSalesSources(inputs)
  console.log(`\ndowngrades: ${audit.downgrades.length}`)
  console.log('month      reported        square       diff      pct  negligible')
  for (const r of audit.downgrades) {
    console.log(
      `${r.month}  ${money(r.reportedRetail ?? 0).padStart(11)}  ${money(
        r.squareDailyRetail ?? 0,
      ).padStart(11)}  ${money(r.difference).padStart(11)}  ${String(
        r.differencePercent,
      ).padStart(6)}%  ${r.isNegligible ? 'yes' : ''}`,
    )
  }
  console.log(`\nnet difference:      ${money(audit.netDifference)}`)
  console.log(`material difference: ${money(audit.materialNetDifference)}`)
  console.log(`negligible months:   ${audit.negligible.map((r) => r.month).join(', ')}`)
  console.log(`locked skipped:      ${audit.lockedSkipped.join(', ') || 'none'}`)

  const up = audit.downgrades.filter((r) => r.difference > 0)
  const down = audit.downgrades.filter((r) => r.difference < 0)
  console.log(
    `\nunderstated: ${up.length} months (+${money(
      up.reduce((s, r) => s + r.difference, 0),
    )})`,
  )
  console.log(
    `overstated:  ${down.length} months (${money(
      down.reduce((s, r) => s + r.difference, 0),
    )})`,
  )
}
main()
