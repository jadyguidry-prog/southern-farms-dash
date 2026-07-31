/**
 * Database layer for calculated sales.
 *
 * Reads financial records, runs them through the pure calculator, and persists
 * the result into `sales_monthly` alongside any manual figures the owner set.
 */
import { createClient } from '@/lib/supabase/server'
import {
  calculateMonthlySales,
  resolveFinal,
  type SalesCalcResult,
  type SalesInputRow,
  type SalesSource,
  type SalesSourceRule,
  type UnclassifiedPayee,
} from '@/lib/sales-calculator'

export type MonthlySalesRow = {
  id: string | null
  year: number
  month: string
  monthOrder: number
  /** What the business reports: manual override if present, else calculated. */
  wholesale: number
  retail: number
  total: number
  calculatedWholesale: number | null
  calculatedRetail: number | null
  manualWholesale: number | null
  manualRetail: number | null
  /** Square's own figures. Null until a month's correction is approved. */
  squareWholesale: number | null
  squareRetail: number | null
  source: SalesSource
  locked: boolean
  transactionCount: number
  calculatedAt: string | null
}

/** Load active classification rules. */
export async function getSalesSourceRules(): Promise<SalesSourceRule[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('sales_source_rules')
    .select('*')
    .eq('active', true)
    .order('priority', { ascending: true })

  return (data ?? []).map((r) => ({
    matchText: String(r.match_text ?? ''),
    matchType: (r.match_type ?? 'contains') as SalesSourceRule['matchType'],
    channel: r.channel as SalesSourceRule['channel'],
    priority: Number(r.priority ?? 10),
    active: Boolean(r.active),
  }))
}

/**
 * Every inflow that could be a sale, paged past PostgREST's 1000-row cap.
 * Missing a page here would silently understate a month's revenue.
 */
async function fetchSalesCandidates(): Promise<SalesInputRow[]> {
  const supabase = await createClient()
  const pageSize = 1000
  const rows: SalesInputRow[] = []

  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from('financial_transactions')
      .select(
        'id, transaction_date, normalized_description, amount, transaction_type',
      )
      .is('deleted_at', null)
      .in('transaction_type', ['income', 'deposit'])
      .order('id', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1)

    if (error) break
    const batch = data ?? []
    rows.push(
      ...batch.map((t) => ({
        id: String(t.id),
        transactionDate: String(t.transaction_date ?? ''),
        normalizedDescription: String(t.normalized_description ?? ''),
        amount: Number(t.amount ?? 0),
        transactionType: String(t.transaction_type ?? ''),
      })),
    )
    if (batch.length < pageSize) break
  }

  return rows
}

/** Run the calculation without writing anything — used for previews. */
export async function previewCalculatedSales(): Promise<SalesCalcResult> {
  const [rows, rules] = await Promise.all([
    fetchSalesCandidates(),
    getSalesSourceRules(),
  ])
  return calculateMonthlySales(rows, rules)
}

/**
 * Recalculate from financial records and store the results.
 *
 * Manual figures are never overwritten, and a month marked `locked` is skipped
 * entirely — once the owner has closed a month, a later import must not quietly
 * restate it.
 */
export async function recalculateSales(): Promise<{
  monthsWritten: number
  monthsSkippedLocked: number
  unclassified: UnclassifiedPayee[]
  excludedTotal: number
  classifiedTotal: number
}> {
  const supabase = await createClient()
  const result = await previewCalculatedSales()

  const { data: existingRows } = await supabase
    .from('sales_monthly')
    .select('id, month, month_order, year, locked')

  const existing = new Map<string, Record<string, unknown>>()
  for (const row of existingRows ?? []) {
    existing.set(`${row.year ?? ''}-${row.month_order}`, row)
    // Rows created before `year` existed are keyed by month alone.
    if (row.year === null) existing.set(`legacy-${row.month_order}`, row)
  }

  let monthsWritten = 0
  let monthsSkippedLocked = 0
  const now = new Date().toISOString()

  for (const month of result.months) {
    const prior =
      existing.get(`${month.year}-${month.monthOrder}`) ??
      existing.get(`legacy-${month.monthOrder}`)

    if (prior?.locked) {
      monthsSkippedLocked += 1
      continue
    }

    const payload = {
      month: month.month,
      month_order: month.monthOrder,
      year: month.year,
      calculated_wholesale: month.wholesale,
      calculated_retail: month.retail,
      transaction_count: month.transactionCount,
      calculated_at: now,
      source: 'calculated',
    }

    if (prior?.id) {
      await supabase
        .from('sales_monthly')
        .update(payload)
        .eq('id', prior.id as string)
    } else {
      // Seed the reported columns too, so a brand-new month is never blank.
      await supabase
        .from('sales_monthly')
        .insert({ ...payload, wholesale: month.wholesale, retail: month.retail })
    }
    monthsWritten += 1
  }

  // Keep the reported wholesale/retail columns in step with the resolved value.
  await syncFinalColumns()

  return {
    monthsWritten,
    monthsSkippedLocked,
    unclassified: result.unclassified,
    excludedTotal: result.excludedTotal,
    classifiedTotal: result.classifiedTotal,
  }
}

/**
 * Mirror the resolved figure into `wholesale`/`retail`.
 *
 * Those two columns are what the Dashboard, reports and AI Advisor already read,
 * so writing the resolved value there keeps every consumer correct without
 * needing to understand calculated-versus-manual precedence.
 */
export async function syncFinalColumns(): Promise<void> {
  const supabase = await createClient()
  const { data } = await supabase.from('sales_monthly').select('*')

  for (const row of data ?? []) {
    // A locked month is closed. `recalculateSales` already skips locked months,
    // but this function is also called on its own, and without the same guard it
    // would restate a closed month behind the owner's back.
    if (row.locked) continue

    const final = resolveFinal({
      calculatedWholesale: row.calculated_wholesale,
      calculatedRetail: row.calculated_retail,
      manualWholesale: row.manual_wholesale,
      manualRetail: row.manual_retail,
      // Square outranks the bank-deposit estimate. These columns are null until a
      // month's correction is approved, so this changes nothing on its own — it is
      // what stops an approved correction being overwritten on the next sync.
      squareWholesale: row.square_wholesale,
      squareRetail: row.square_retail,
    })

    if (final.source === 'empty') continue
    if (
      Number(row.wholesale ?? -1) === final.wholesale &&
      Number(row.retail ?? -1) === final.retail &&
      row.source === final.source
    ) {
      continue
    }

    await supabase
      .from('sales_monthly')
      .update({
        wholesale: final.wholesale,
        retail: final.retail,
        source: final.source,
      })
      .eq('id', row.id)
  }
}

/** Monthly sales with full provenance, for the Sales page and Admin. */
export async function getMonthlySalesDetail(): Promise<MonthlySalesRow[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('sales_monthly')
    .select('*')
    .order('year', { ascending: true })
    .order('month_order', { ascending: true })

  return (data ?? []).map((row) => {
    const final = resolveFinal({
      calculatedWholesale: row.calculated_wholesale,
      calculatedRetail: row.calculated_retail,
      manualWholesale: row.manual_wholesale,
      manualRetail: row.manual_retail,
      squareWholesale: row.square_wholesale,
      squareRetail: row.square_retail,
    })

    return {
      id: row.id ? String(row.id) : null,
      year: Number(row.year ?? 0),
      month: String(row.month ?? ''),
      monthOrder: Number(row.month_order ?? 0),
      wholesale: final.wholesale,
      retail: final.retail,
      total: Math.round((final.wholesale + final.retail) * 100) / 100,
      calculatedWholesale: numOrNull(row.calculated_wholesale),
      calculatedRetail: numOrNull(row.calculated_retail),
      manualWholesale: numOrNull(row.manual_wholesale),
      manualRetail: numOrNull(row.manual_retail),
      squareWholesale: numOrNull(row.square_wholesale),
      squareRetail: numOrNull(row.square_retail),
      source: final.source,
      locked: Boolean(row.locked),
      transactionCount: Number(row.transaction_count ?? 0),
      calculatedAt: row.calculated_at ? String(row.calculated_at) : null,
    }
  })
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
