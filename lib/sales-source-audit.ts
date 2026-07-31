/**
 * Detects months whose reported sales figure comes from a weaker source than
 * the best one available.
 *
 * Why this exists: `lib/sales-source.ts` already ranks the sources correctly
 * (Square above bank-derived estimates) and is fully tested — but nothing in
 * production ever called it. The reported `retail` column is written by
 * `resolveFinal`, which only understands "manual vs calculated" and has no
 * concept of Square at all. So when the monthly Square columns were not
 * populated, a bank-payout estimate was promoted into the reported figure even
 * though Square's own daily records for that month existed all along.
 *
 * A bank payout is not sales: it is what landed after Square withheld its fees
 * and held funds back over a weekend, so using it understates revenue.
 *
 * This module only *reports* the discrepancy. It applies nothing, because a
 * restatement of past revenue is the owner's decision, not a sync's.
 *
 * Pure functions, no DB access, so the rules are directly testable.
 */

import {
  asSalesDataSource,
  SOURCE_RANK,
  SOURCE_LABELS,
  type SalesDataSource,
} from '@/lib/sales-source'

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Sum Square's retail sales per month, keeping only the highest-ranked source
 * for any date that appears more than once.
 *
 * `sales_daily` permits more than one row per date — one from the live API sync
 * and one from a CSV export covering the same period — so a plain sum can
 * double-count a day. There are no duplicates in the data today, which is
 * precisely why this is written defensively now rather than after a CSV
 * re-import silently inflates every figure.
 *
 * Lives in this pure module (not the DB layer) so the collapsing behaviour is
 * testable without a database.
 */
export function aggregateDailyRetailByMonth(
  raw: { sale_date?: unknown; source?: unknown; retail_sales?: unknown }[],
): Map<string, number> {
  const winnerByDate = new Map<string, { rank: number; retail: number }>()

  for (const r of raw) {
    const saleDate = String(r.sale_date ?? '')
    const source = asSalesDataSource(typeof r.source === 'string' ? r.source : null)
    // An unranked source cannot be compared safely, so it is skipped rather than
    // allowed to outrank a known-good figure.
    if (!saleDate || !source) continue

    const rank = SOURCE_RANK[source]
    const existing = winnerByDate.get(saleDate)
    if (!existing || rank > existing.rank) {
      winnerByDate.set(saleDate, { rank, retail: num(r.retail_sales) })
    }
  }

  const byMonth = new Map<string, number>()
  for (const [saleDate, winner] of winnerByDate) {
    const mk = saleDate.slice(0, 7)
    if (mk.length !== 7) continue
    byMonth.set(mk, Number(((byMonth.get(mk) ?? 0) + winner.retail).toFixed(2)))
  }
  return byMonth
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const

/**
 * Build a `YYYY-MM` key from a year and a month name.
 *
 * `sales_monthly` stores month names as free text and mixes forms — "May" but
 * also "Jun" and "Sep". Matching on the full name silently fails for the
 * abbreviated ones, and a failed match here does not raise an error: it just
 * makes a month look like it has no Square data, so a real discrepancy
 * disappears from the report. Matching on the first three letters covers both
 * forms, since no two English months share a three-letter prefix.
 *
 * Returns null for anything unrecognised rather than guessing a month.
 */
export function monthKey(year: number, monthName: string): string | null {
  const prefix = String(monthName).trim().toLowerCase().slice(0, 3)
  if (prefix.length < 3) return null
  const index = MONTH_NAMES.findIndex((m) => m.slice(0, 3) === prefix)
  if (index === -1) return null
  if (!Number.isFinite(year) || year <= 0) return null
  return `${year}-${String(index + 1).padStart(2, '0')}`
}

/** What one month currently reports, and what each source has for it. */
export type MonthAuditInput = {
  /** `YYYY-MM`. */
  month: string
  /** The figure currently shown in reports. */
  reportedRetail: number | null
  /** Which source that reported figure came from. */
  reportedSource: SalesDataSource | null
  /**
   * Retail total from Square's own per-day records for this month, or null when
   * Square genuinely has nothing. Compared like-for-like against retail: total
   * net sales would include wholesale and overstate the gap.
   */
  squareDailyRetail: number | null
  /** True when the owner has declared the month final. */
  locked?: boolean | null
}

export type MonthAuditRow = {
  month: string
  reportedRetail: number | null
  reportedSource: SalesDataSource | null
  reportedSourceLabel: string
  squareDailyRetail: number | null
  /** Positive means the reported figure is too low. */
  difference: number
  /**
   * Size of the gap relative to the reported figure, as a percentage. A $136 gap
   * means something very different on a $48,000 month than on a $500 one, and the
   * absolute number alone cannot convey that.
   */
  differencePercent: number
  /**
   * True when the gap is real but too small to matter (under
   * `NEGLIGIBLE_GAP_PERCENT` of the month). Still reported and still correctable
   * — it is simply labelled so a rounding-sized difference is not mistaken for
   * the same problem as a $23,000 one.
   */
  isNegligible: boolean
  /** True when a better-ranked source exists and disagrees with what is shown. */
  isDowngrade: boolean
  /** Plain-language explanation for the owner. */
  explanation: string
}

export type SalesSourceAudit = {
  rows: MonthAuditRow[]
  /** Only the months where a weaker source is being reported. */
  downgrades: MonthAuditRow[]
  /** Net change to reported revenue if every downgrade were corrected. */
  netDifference: number
  /**
   * Net change excluding negligible gaps, so the headline figure is not inflated
   * by rounding-sized differences.
   */
  materialNetDifference: number
  /** Downgrades whose gap is too small to matter. */
  negligible: MonthAuditRow[]
  /** Months skipped because the owner locked them. */
  lockedSkipped: string[]
}

/**
 * Gaps at or below this share of the month's reported figure are labelled
 * negligible. Chosen so a sub-1% difference — the scale of a rounding or
 * timing artefact — reads differently from a material restatement, without
 * being hidden.
 */
export const NEGLIGIBLE_GAP_PERCENT = 1

/** Two money figures within a cent are the same number. */
function differs(a: number, b: number): boolean {
  return Math.abs(a - b) > 0.01
}

function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/**
 * Compare what each month reports against the best source available.
 *
 * A month is a "downgrade" only when ALL of these hold, so that ordinary
 * rounding or a legitimately absent Square month is never flagged:
 *  - Square has a figure for the month,
 *  - the reported figure came from a lower-ranked source than Square,
 *  - and the two actually differ by more than a cent.
 *
 * Locked months are reported but never counted: the owner has frozen them,
 * usually because tax has been filed, and silently restating them would be the
 * same class of mistake this module exists to catch.
 */
export function auditSalesSources(inputs: MonthAuditInput[]): SalesSourceAudit {
  const rows: MonthAuditRow[] = []
  const lockedSkipped: string[] = []

  for (const input of inputs) {
    const { month, reportedRetail, reportedSource, squareDailyRetail } = input
    const locked = Boolean(input.locked)

    const reportedRank = reportedSource ? SOURCE_RANK[reportedSource] : 0
    const squareRank = SOURCE_RANK.square_api
    const hasSquare = squareDailyRetail != null

    const difference =
      hasSquare && reportedRetail != null
        ? Number((squareDailyRetail - reportedRetail).toFixed(2))
        : 0

    // A manual entry outranks Square on purpose — the owner correcting a figure
    // must not be overridden — so it is never treated as a downgrade.
    const beatenBySquare = hasSquare && reportedRank < squareRank
    const reallyDiffers =
      hasSquare && reportedRetail != null && differs(squareDailyRetail, reportedRetail)

    const isDowngrade = !locked && beatenBySquare && reallyDiffers

    // Guard against dividing by a zero or absent reported figure: a gap against
    // nothing is not 0% agreement, it is unmeasurable, and calling it negligible
    // would bury a month that reports no revenue at all.
    const differencePercent =
      reportedRetail != null && Math.abs(reportedRetail) > 0.01
        ? Number(((Math.abs(difference) / Math.abs(reportedRetail)) * 100).toFixed(2))
        : 0
    const isNegligible =
      isDowngrade &&
      reportedRetail != null &&
      Math.abs(reportedRetail) > 0.01 &&
      differencePercent <= NEGLIGIBLE_GAP_PERCENT

    if (locked && beatenBySquare && reallyDiffers) lockedSkipped.push(month)

    let explanation: string
    if (!hasSquare) {
      explanation =
        reportedSource === 'calculated'
          ? 'Estimated from bank deposits. Square has no records for this month, so there is nothing better to use.'
          : `From ${reportedSource ? SOURCE_LABELS[reportedSource] : 'no source'}.`
    } else if (locked && reallyDiffers) {
      explanation = `Locked by you, so it is left alone. Square records ${money(
        squareDailyRetail as number,
      )} for this month.`
    } else if (isDowngrade) {
      explanation = `Reported from ${
        reportedSource ? SOURCE_LABELS[reportedSource] : 'an unknown source'
      }, but Square has its own records for this month showing ${money(
        squareDailyRetail as number,
      )}. A bank deposit is what arrived after Square's fees and holdbacks, so it ${
        difference > 0 ? 'understates' : 'misstates'
      } what was actually sold.${
        isNegligible
          ? ` The gap is only ${differencePercent}% of the month, so correcting this one barely moves your numbers.`
          : ''
      }`
    } else if (reportedSource === 'manual') {
      explanation = 'Your own entered figure, which takes priority over Square.'
    } else {
      explanation = `From ${
        reportedSource ? SOURCE_LABELS[reportedSource] : 'no source'
      }, and it matches Square.`
    }

    rows.push({
      month,
      reportedRetail,
      reportedSource,
      reportedSourceLabel: reportedSource ? SOURCE_LABELS[reportedSource] : 'None',
      squareDailyRetail,
      difference,
      differencePercent,
      isNegligible,
      isDowngrade,
      explanation,
    })
  }

  rows.sort((a, b) => a.month.localeCompare(b.month))
  const downgrades = rows.filter((r) => r.isDowngrade)

  return {
    rows,
    downgrades,
    netDifference: Number(
      downgrades.reduce((sum, r) => sum + r.difference, 0).toFixed(2),
    ),
    materialNetDifference: Number(
      downgrades
        .filter((r) => !r.isNegligible)
        .reduce((sum, r) => sum + r.difference, 0)
        .toFixed(2),
    ),
    negligible: downgrades.filter((r) => r.isNegligible),
    lockedSkipped,
  }
}
