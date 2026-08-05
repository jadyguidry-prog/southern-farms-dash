/**
 * Read layer for Square point-of-sale data.
 *
 * `sales_daily` can hold more than one row for the same date — one from the live
 * API sync and one from a CSV export of the same period. Summing the table
 * directly would double-count that day's revenue, so every read here collapses
 * to one winning row per date using the shared precedence rules.
 *
 * All figures are returned as plain numbers ready for display. Nothing here
 * invents a value: when Square has no data the totals are null and the caller
 * is expected to say so rather than render a confident zero.
 */
import { createClient } from '@/lib/supabase/server'
import {
  asSalesDataSource,
  SOURCE_LABELS,
  SOURCE_RANK,
  type SalesDataSource,
} from '@/lib/sales-source'

export type SquareDailyRow = {
  saleDate: string
  source: SalesDataSource
  grossSales: number
  netSales: number
  discounts: number
  refunds: number
  taxes: number
  tips: number
  processingFees: number
  transactionCount: number
  averageTicket: number | null
  /** Other sources that also reported this date, for provenance in the UI. */
  supersededSources: SalesDataSource[]
}

export type SquareSalesSummary = {
  /** Null when Square has produced no data at all — not zero. */
  netSales: number | null
  grossSales: number | null
  refunds: number
  discounts: number
  processingFees: number
  transactionCount: number
  /** Net sales divided by transactions, null when there are no transactions. */
  averageTicket: number | null
  dayCount: number
  firstDate: string | null
  lastDate: string | null
  /** How many days came from each source, so the UI can show provenance. */
  sourceMix: { source: SalesDataSource; label: string; days: number }[]
  /** Days where two sources disagreed on net sales by more than a cent. */
  conflictDays: string[]
}

export type SquareCategoryRow = {
  category: string
  revenue: number
  units: number
  source: SalesDataSource
}

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Collapse multiple source rows per date down to the winning row.
 *
 * Exported so the precedence behaviour can be tested without a database.
 */
export function resolveDailyRows(
  raw: {
    sale_date?: unknown
    source?: unknown
    gross_sales?: unknown
    net_sales?: unknown
    discounts?: unknown
    refunds?: unknown
    taxes?: unknown
    tips?: unknown
    processing_fees?: unknown
    transaction_count?: unknown
    average_ticket?: unknown
  }[],
): { rows: SquareDailyRow[]; conflictDays: string[] } {
  const byDate = new Map<string, SquareDailyRow[]>()

  for (const r of raw) {
    const saleDate = String(r.sale_date ?? '')
    const source = asSalesDataSource(
      typeof r.source === 'string' ? r.source : null,
    )
    // An unrecognised source has no rank, so it cannot be compared safely.
    // Skipping it is better than letting it outrank a known-good figure.
    if (!saleDate || !source) continue

    const txns = Math.trunc(num(r.transaction_count))
    const net = num(r.net_sales)
    const stored = num(r.average_ticket)

    const row: SquareDailyRow = {
      saleDate,
      source,
      grossSales: num(r.gross_sales),
      netSales: net,
      discounts: num(r.discounts),
      refunds: num(r.refunds),
      taxes: num(r.taxes),
      tips: num(r.tips),
      processingFees: num(r.processing_fees),
      transactionCount: txns,
      // Prefer the stored ticket, but derive it when absent so the column is
      // not blank for CSV imports that never carried the field.
      averageTicket: stored > 0 ? stored : txns > 0 ? net / txns : null,
      supersededSources: [],
    }

    const list = byDate.get(saleDate)
    if (list) list.push(row)
    else byDate.set(saleDate, [row])
  }

  const rows: SquareDailyRow[] = []
  const conflictDays: string[] = []

  for (const [saleDate, candidates] of byDate) {
    const winner = candidates.reduce((best, c) =>
      SOURCE_RANK[c.source] > SOURCE_RANK[best.source] ? c : best,
    )
    const losers = candidates.filter((c) => c !== winner)

    winner.supersededSources = losers.map((l) => l.source)
    if (losers.some((l) => Math.abs(l.netSales - winner.netSales) > 0.01)) {
      conflictDays.push(saleDate)
    }
    rows.push(winner)
  }

  rows.sort((a, b) => a.saleDate.localeCompare(b.saleDate))
  conflictDays.sort()
  return { rows, conflictDays }
}

/**
 * Daily Square rows, newest last, optionally limited to a start date.
 * Paged past PostgREST's 1000-row cap so a long history is never truncated.
 */
export async function getSquareDailySales(options?: {
  since?: string
  until?: string
}): Promise<{ rows: SquareDailyRow[]; conflictDays: string[] }> {
  const supabase = await createClient()
  const pageSize = 1000
  const raw: Record<string, unknown>[] = []

  for (let page = 0; ; page += 1) {
    let query = supabase
      .from('sales_daily')
      .select(
        'sale_date, source, gross_sales, net_sales, discounts, refunds, taxes, tips, processing_fees, transaction_count, average_ticket',
      )
      .order('sale_date', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1)

    if (options?.since) query = query.gte('sale_date', options.since)
    if (options?.until) query = query.lte('sale_date', options.until)

    const { data, error } = await query
    if (error) break
    const batch = data ?? []
    raw.push(...batch)
    if (batch.length < pageSize) break
  }

  return resolveDailyRows(raw)
}

/** Aggregate the resolved daily rows into headline figures. */
export function summarizeDailyRows(
  rows: SquareDailyRow[],
  conflictDays: string[] = [],
): SquareSalesSummary {
  if (rows.length === 0) {
    return {
      netSales: null,
      grossSales: null,
      refunds: 0,
      discounts: 0,
      processingFees: 0,
      transactionCount: 0,
      averageTicket: null,
      dayCount: 0,
      firstDate: null,
      lastDate: null,
      sourceMix: [],
      conflictDays: [],
    }
  }

  let netSales = 0
  let grossSales = 0
  let refunds = 0
  let discounts = 0
  let processingFees = 0
  let transactionCount = 0
  const daysBySource = new Map<SalesDataSource, number>()

  for (const r of rows) {
    netSales += r.netSales
    grossSales += r.grossSales
    refunds += r.refunds
    discounts += r.discounts
    processingFees += r.processingFees
    transactionCount += r.transactionCount
    daysBySource.set(r.source, (daysBySource.get(r.source) ?? 0) + 1)
  }

  const round = (n: number) => Math.round(n * 100) / 100

  return {
    netSales: round(netSales),
    grossSales: round(grossSales),
    refunds: round(refunds),
    discounts: round(discounts),
    processingFees: round(processingFees),
    transactionCount,
    averageTicket:
      transactionCount > 0 ? round(netSales / transactionCount) : null,
    dayCount: rows.length,
    firstDate: rows[0].saleDate,
    lastDate: rows[rows.length - 1].saleDate,
    sourceMix: [...daysBySource.entries()]
      .sort((a, b) => SOURCE_RANK[b[0]] - SOURCE_RANK[a[0]])
      .map(([source, days]) => ({
        source,
        label: SOURCE_LABELS[source],
        days,
      })),
    conflictDays,
  }
}

export type SquareWeeklySales = {
  /** Net sales over the trailing 7 days ending at the latest recorded day. */
  netSales: number | null
  /** Net sales for the 7 days before that, for a like-for-like comparison. */
  priorNetSales: number | null
  transactionCount: number
  refunds: number
  processingFees: number
  /** Latest day Square has data for, so staleness can be reported honestly. */
  latestDate: string | null
  /** Days of actual data in the window (may be fewer than 7). */
  daysCovered: number
  /**
   * Days of actual data in the PRIOR window. Exposed so callers can verify the
   * two windows are like-for-like before reporting a percentage change: a
   * 3-day current week measured against a 7-day prior week would read as a
   * collapse that is really just missing days.
   */
  priorDaysCovered: number
}

/**
 * Trailing-week Square sales, measured from the most recent day that has data
 * rather than from today.
 *
 * Anchoring on "today" would make the figure collapse toward zero whenever a
 * sync fell behind, which would then trip the sales health pillar into a false
 * alarm. Anchoring on the last real day keeps the number meaningful, and
 * `latestDate` lets the caller warn that it is stale.
 */
export function computeWeeklySales(rows: SquareDailyRow[]): SquareWeeklySales {
  if (rows.length === 0) {
    return {
      netSales: null,
      priorNetSales: null,
      transactionCount: 0,
      refunds: 0,
      processingFees: 0,
      latestDate: null,
      daysCovered: 0,
      priorDaysCovered: 0,
    }
  }

  // rows are sorted ascending by resolveDailyRows.
  const latestDate = rows[rows.length - 1].saleDate
  const latest = new Date(`${latestDate}T00:00:00Z`)

  const dayMs = 86_400_000
  // Inclusive 7-day window ending on the latest day.
  const currentStart = new Date(latest.getTime() - 6 * dayMs)
  const priorStart = new Date(latest.getTime() - 13 * dayMs)
  const priorEnd = new Date(latest.getTime() - 7 * dayMs)

  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const cs = iso(currentStart)
  const ps = iso(priorStart)
  const pe = iso(priorEnd)

  let netSales = 0
  let priorNetSales = 0
  let transactionCount = 0
  let refunds = 0
  let processingFees = 0
  let daysCovered = 0
  let priorDays = 0

  for (const r of rows) {
    if (r.saleDate >= cs && r.saleDate <= latestDate) {
      netSales += r.netSales
      transactionCount += r.transactionCount
      refunds += r.refunds
      processingFees += r.processingFees
      daysCovered += 1
    } else if (r.saleDate >= ps && r.saleDate <= pe) {
      priorNetSales += r.netSales
      priorDays += 1
    }
  }

  const round = (n: number) => Math.round(n * 100) / 100

  return {
    netSales: round(netSales),
    // Null rather than 0 when there is no prior week, so the UI does not show
    // a misleading "+100%" against a week that simply has no data.
    priorNetSales: priorDays > 0 ? round(priorNetSales) : null,
    transactionCount,
    refunds: round(refunds),
    processingFees: round(processingFees),
    latestDate,
    daysCovered,
    priorDaysCovered: priorDays,
  }
}

export type SquareMonthlySales = {
  /** Gross sales for the current month, through `latestDate`. */
  grossSales: number | null
  /** Net sales for the same window. */
  netSales: number | null
  /**
   * Prior month over the SAME day range (1st through the same day-of-month), so
   * a half-finished month is never compared against a complete one.
   */
  priorNetSales: number | null
  /** The prior month in full, for context once the current month closes. */
  priorFullNetSales: number | null
  transactionCount: number
  refunds: number
  /** First day of the month being reported, e.g. `2026-07-01`. */
  monthStart: string | null
  /** Latest day Square has data for, so staleness can be reported honestly. */
  latestDate: string | null
  /** Days of actual sales data counted in the month (closed days do not count). */
  daysCovered: number
  /** True when `latestDate` is the final calendar day of its month. */
  monthComplete: boolean
}

/**
 * Month-to-date Square sales.
 *
 * Anchored on the most recent day that has data rather than on today, for the
 * same reason as `computeWeeklySales`: a lagging sync must not make sales look
 * like they collapsed.
 *
 * The comparison is deliberately like-for-like. Measuring a month that is 27
 * days in against a complete prior month would report a double-digit "decline"
 * that is really just the missing days, so the prior month is truncated to the
 * same day-of-month before the two are compared.
 */
export function computeMonthlySales(rows: SquareDailyRow[]): SquareMonthlySales {
  if (rows.length === 0) {
    return {
      grossSales: null,
      netSales: null,
      priorNetSales: null,
      priorFullNetSales: null,
      transactionCount: 0,
      refunds: 0,
      monthStart: null,
      latestDate: null,
      daysCovered: 0,
      monthComplete: false,
    }
  }

  // rows are sorted ascending by resolveDailyRows.
  const latestDate = rows[rows.length - 1].saleDate
  const year = Number(latestDate.slice(0, 4))
  const month = Number(latestDate.slice(5, 7)) // 1-12
  const dayOfMonth = Number(latestDate.slice(8, 10))

  const pad = (n: number) => String(n).padStart(2, '0')
  const monthStart = `${year}-${pad(month)}-01`

  // Previous calendar month, rolling the year over at January.
  const pYear = month === 1 ? year - 1 : year
  const pMonth = month === 1 ? 12 : month - 1
  const priorStart = `${pYear}-${pad(pMonth)}-01`
  // Day 0 of the following month is the last day of the month in question.
  const priorLastDay = new Date(Date.UTC(pYear, pMonth, 0)).getUTCDate()
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  // Clamp: a comparison through Mar 31 has no Feb 31 to match, so use Feb's end.
  const priorCutoff = `${pYear}-${pad(pMonth)}-${pad(Math.min(dayOfMonth, priorLastDay))}`
  const priorEnd = `${pYear}-${pad(pMonth)}-${pad(priorLastDay)}`

  let grossSales = 0
  let netSales = 0
  let transactionCount = 0
  let refunds = 0
  let daysCovered = 0
  let priorNetSales = 0
  let priorDays = 0
  let priorFullNetSales = 0
  let priorFullDays = 0

  for (const r of rows) {
    const d = r.saleDate
    if (d >= monthStart && d <= latestDate) {
      grossSales += r.grossSales
      netSales += r.netSales
      transactionCount += r.transactionCount
      refunds += r.refunds
      daysCovered += 1
    } else if (d >= priorStart && d <= priorEnd) {
      priorFullNetSales += r.netSales
      priorFullDays += 1
      if (d <= priorCutoff) {
        priorNetSales += r.netSales
        priorDays += 1
      }
    }
  }

  const round = (n: number) => Math.round(n * 100) / 100

  return {
    grossSales: round(grossSales),
    netSales: round(netSales),
    // Null rather than 0 when the prior month has no data, so the UI does not
    // show a misleading "+100%" against a month that was never recorded.
    priorNetSales: priorDays > 0 ? round(priorNetSales) : null,
    priorFullNetSales: priorFullDays > 0 ? round(priorFullNetSales) : null,
    transactionCount,
    refunds: round(refunds),
    monthStart,
    latestDate,
    daysCovered,
    monthComplete: dayOfMonth >= daysInMonth,
  }
}

/** Month-to-date Square sales read straight from the database. */
export async function getSquareMonthlySales(): Promise<SquareMonthlySales> {
  const { rows } = await getSquareDailySales()
  return computeMonthlySales(rows)
}

/** Trailing-week Square sales read straight from the database. */
export async function getSquareWeeklySales(): Promise<SquareWeeklySales> {
  const { rows } = await getSquareDailySales()
  return computeWeeklySales(rows)
}

/** Convenience: fetch and summarize in one call. */
export async function getSquareSalesSummary(options?: {
  since?: string
  until?: string
}): Promise<SquareSalesSummary> {
  const { rows, conflictDays } = await getSquareDailySales(options)
  return summarizeDailyRows(rows, conflictDays)
}

/**
 * Category revenue from Square, highest first.
 *
 * Like the daily table this can hold several sources for one category and
 * period, so only the highest-ranked source is counted.
 */
export async function getSquareCategoryBreakdown(
  limit = 12,
): Promise<SquareCategoryRow[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('sales_by_category')
    .select('category_name, period_start, source, revenue, units')

  // Key on category + period so two different months are not merged, then keep
  // only the winning source for each.
  const best = new Map<
    string,
    { category: string; revenue: number; units: number; source: SalesDataSource }
  >()

  for (const r of data ?? []) {
    const category = String(r.category_name ?? '').trim()
    const source = asSalesDataSource(
      typeof r.source === 'string' ? r.source : null,
    )
    if (!category || !source) continue

    const key = `${category}||${String(r.period_start ?? '')}`
    const existing = best.get(key)
    if (existing && SOURCE_RANK[existing.source] >= SOURCE_RANK[source]) continue

    best.set(key, {
      category,
      revenue: num(r.revenue),
      units: num(r.units),
      source,
    })
  }

  // Roll the surviving period rows up per category.
  const totals = new Map<string, SquareCategoryRow>()
  for (const row of best.values()) {
    const existing = totals.get(row.category)
    if (existing) {
      existing.revenue += row.revenue
      existing.units += row.units
    } else {
      totals.set(row.category, { ...row })
    }
  }

  return [...totals.values()]
    .map((r) => ({
      ...r,
      revenue: Math.round(r.revenue * 100) / 100,
      units: Math.round(r.units * 100) / 100,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit)
}
