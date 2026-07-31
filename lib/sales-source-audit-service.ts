/**
 * Database layer for the sales-source audit.
 *
 * Reads what each month currently reports (`sales_monthly`) and what Square's
 * own daily records say (`sales_daily`), then hands both to the pure rules in
 * `lib/sales-source-audit.ts`.
 *
 * Two things here are easy to get wrong and both were verified against the live
 * data before this was written:
 *
 * 1. **Compare retail with retail.** `sales_daily.net_sales` includes wholesale
 *    (for 2026-06: retail 70,521.14 + wholesale 8,571.89 = net 79,093.03). The
 *    reported `sales_monthly.retail` column is retail only, so comparing it to
 *    net would invent a wholesale-sized discrepancy that does not exist.
 * 2. **Collapse duplicate days before summing.** `sales_daily` permits more than
 *    one row per date — one from the live API and one from a CSV of the same
 *    period — so a plain sum can double-count. There are no duplicates in the
 *    data today, which is exactly why this must be written defensively now
 *    rather than after a CSV re-import silently inflates every figure.
 */
import { createClient } from '@/lib/supabase/server'
import { asSalesDataSource } from '@/lib/sales-source'
import {
  aggregateDailyRetailByMonth,
  auditSalesSources,
  monthKey,
  type MonthAuditInput,
  type SalesSourceAudit,
} from '@/lib/sales-source-audit'

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Build the audit for every month that has a reported figure.
 *
 * Both reads are paged: PostgREST silently caps at 1,000 rows, and a silent cap
 * here would drop the most recent days and make healthy months look overstated.
 */
export async function getSalesSourceAudit(): Promise<SalesSourceAudit> {
  const supabase = await createClient()

  const monthlyRaw: Record<string, unknown>[] = []
  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from('sales_monthly')
      .select('year, month, retail, source, locked')
      .range(page * 1000, page * 1000 + 999)
    if (error) break
    const batch = data ?? []
    monthlyRaw.push(...batch)
    if (batch.length < 1000) break
  }

  const dailyRaw: Record<string, unknown>[] = []
  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from('sales_daily')
      .select('sale_date, source, retail_sales')
      .order('sale_date', { ascending: true })
      .range(page * 1000, page * 1000 + 999)
    if (error) break
    const batch = data ?? []
    dailyRaw.push(...batch)
    if (batch.length < 1000) break
  }

  const squareByMonth = aggregateDailyRetailByMonth(dailyRaw)

  const inputs: MonthAuditInput[] = []
  for (const row of monthlyRaw) {
    const mk = monthKey(Number(row.year), String(row.month ?? ''))
    // An unparseable month is skipped rather than guessed. Guessing would
    // attribute one month's Square data to another.
    if (!mk) continue

    const squareRetail = squareByMonth.has(mk) ? (squareByMonth.get(mk) as number) : null

    inputs.push({
      month: mk,
      reportedRetail: row.retail == null ? null : num(row.retail),
      reportedSource: asSalesDataSource(
        typeof row.source === 'string' ? row.source : null,
      ),
      squareDailyRetail: squareRetail,
      locked: Boolean(row.locked),
    })
  }

  return auditSalesSources(inputs)
}
