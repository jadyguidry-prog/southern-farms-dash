/**
 * Sales calculation, derived from whatever financial records exist.
 *
 * This file is deliberately free of database access so the money math can be
 * tested directly. It answers two questions:
 *   1. Is a given bank line actually a sale, and through which channel?
 *   2. What do those lines add up to per month?
 *
 * The classification step matters more than the arithmetic. A bank statement
 * mixes real revenue with loan advances, owner deposits and transfers between
 * your own accounts. Counting any of those as sales overstates revenue, which
 * then corrupts margin, the Dashboard KPIs and every report downstream.
 */

/** Where a sale came from. `exclude` means "not revenue at all". */
export type SalesChannel = 'retail' | 'wholesale' | 'exclude'

export const SALES_CHANNELS: SalesChannel[] = ['retail', 'wholesale', 'exclude']

/**
 * Transaction types that can possibly represent a sale.
 *
 * Deliberately narrow: `refund` is money going back to a customer and
 * `transfer` is internal movement, so neither belongs in revenue.
 */
export const SALES_CANDIDATE_TYPES = ['income', 'deposit'] as const

export type SalesSourceRule = {
  matchText: string
  matchType: 'contains' | 'exact' | 'starts_with'
  channel: SalesChannel
  priority: number
  active: boolean
}

export type SalesInputRow = {
  id: string
  transactionDate: string
  normalizedDescription: string
  amount: number
  transactionType: string
}

export type MonthlySalesCalc = {
  year: number
  monthOrder: number
  month: string
  wholesale: number
  retail: number
  transactionCount: number
}

export type UnclassifiedPayee = {
  description: string
  count: number
  total: number
}

export type SalesCalcResult = {
  months: MonthlySalesCalc[]
  /** Inflows no rule covered — real revenue may be hiding here. */
  unclassified: UnclassifiedPayee[]
  excludedTotal: number
  classifiedTotal: number
}

export const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/**
 * Decide the channel for one description.
 *
 * Lower `priority` wins, which lets a narrow exclusion beat a broad include.
 * That ordering is what stops "SQUARE INC SQ CAP5725" (a Square Capital loan
 * advance) from being swept up by the general "SQUARE INC" retail rule — a
 * $36k error in a single line if it got through.
 */
export function classifySalesRow(
  normalizedDescription: string,
  rules: SalesSourceRule[],
): SalesSourceRule | null {
  const text = (normalizedDescription ?? '').toUpperCase()
  if (!text) return null

  let winner: SalesSourceRule | null = null

  for (const rule of rules) {
    if (!rule.active) continue
    const needle = rule.matchText.toUpperCase()
    if (!needle) continue

    const hit =
      rule.matchType === 'exact'
        ? text.trim() === needle
        : rule.matchType === 'starts_with'
          ? text.startsWith(needle)
          : text.includes(needle)

    if (!hit) continue

    // Tie-break on specificity so the longer, more precise phrase wins.
    if (
      !winner ||
      rule.priority < winner.priority ||
      (rule.priority === winner.priority &&
        needle.length > winner.matchText.length)
    ) {
      winner = rule
    }
  }

  return winner
}

/** Parse `YYYY-MM-DD` without timezone drift shifting a date across a month. */
function parseYearMonth(dateStr: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})/.exec(String(dateStr ?? ''))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (!year || month < 1 || month > 12) return null
  return { year, month }
}

/**
 * Roll classified inflows up into per-month wholesale and retail totals.
 *
 * Amounts are taken as absolute values because import sign conventions differ
 * between banks; the channel, not the sign, decides where money lands.
 */
export function calculateMonthlySales(
  rows: SalesInputRow[],
  rules: SalesSourceRule[],
): SalesCalcResult {
  const buckets = new Map<string, MonthlySalesCalc>()
  const unmatched = new Map<string, UnclassifiedPayee>()
  let excludedTotal = 0
  let classifiedTotal = 0

  for (const row of rows) {
    if (!SALES_CANDIDATE_TYPES.includes(row.transactionType as never)) continue

    const period = parseYearMonth(row.transactionDate)
    if (!period) continue

    const amount = Math.abs(Number(row.amount) || 0)
    if (amount === 0) continue

    const rule = classifySalesRow(row.normalizedDescription, rules)

    if (!rule) {
      const key = row.normalizedDescription || '(no description)'
      const seen = unmatched.get(key)
      if (seen) {
        seen.count += 1
        seen.total += amount
      } else {
        unmatched.set(key, { description: key, count: 1, total: amount })
      }
      continue
    }

    if (rule.channel === 'exclude') {
      excludedTotal += amount
      continue
    }

    const key = `${period.year}-${period.month}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        year: period.year,
        monthOrder: period.month,
        month: MONTH_NAMES[period.month - 1],
        wholesale: 0,
        retail: 0,
        transactionCount: 0,
      }
      buckets.set(key, bucket)
    }

    if (rule.channel === 'retail') bucket.retail += amount
    else bucket.wholesale += amount

    bucket.transactionCount += 1
    classifiedTotal += amount
  }

  const months = [...buckets.values()]
    .map((m) => ({
      ...m,
      wholesale: round2(m.wholesale),
      retail: round2(m.retail),
    }))
    .sort((a, b) => a.year - b.year || a.monthOrder - b.monthOrder)

  const unclassified = [...unmatched.values()]
    .map((u) => ({ ...u, total: round2(u.total) }))
    .sort((a, b) => b.total - a.total)

  return {
    months,
    unclassified,
    excludedTotal: round2(excludedTotal),
    classifiedTotal: round2(classifiedTotal),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export type SalesSource = 'calculated' | 'square' | 'manual' | 'mixed' | 'empty'

/**
 * Which source won a single figure, best first.
 *
 * `square` sits above `calculated` because Square records what was actually
 * rung up, while `calculated` is inferred from bank deposits — and a deposit is
 * what landed *after* Square's fees and holdbacks, so it systematically
 * understates sales. `manual` still wins because the owner may know something
 * neither system does.
 */
const TIER_ORDER = ['manual', 'square', 'calculated'] as const
type Tier = (typeof TIER_ORDER)[number]

/** Pick the best available figure for one channel, and say where it came from. */
function pickBest(
  candidates: Record<Tier, number | null | undefined>,
): { value: number; tier: Tier | null } {
  for (const tier of TIER_ORDER) {
    if (isNum(candidates[tier])) return { value: Number(candidates[tier]), tier }
  }
  return { value: 0, tier: null }
}

/**
 * Resolve the figure the business should actually report.
 *
 * Previously this only knew about manual and calculated figures, so a month with
 * real Square data still reported the bank-deposit estimate. That is the defect
 * that understated retail revenue across nine months: nothing errored, the wrong
 * number simply looked authoritative. Square is now ranked between the two.
 *
 * Recording *which* source won keeps the dashboard honest about whether a number
 * is measured or asserted.
 */
export function resolveFinal(input: {
  calculatedWholesale: number | null
  calculatedRetail: number | null
  manualWholesale: number | null
  manualRetail: number | null
  /**
   * Square's own figures for the month. Optional so existing callers keep their
   * current behaviour until they supply them.
   */
  squareWholesale?: number | null
  squareRetail?: number | null
}): { wholesale: number; retail: number; source: SalesSource } {
  const wholesale = pickBest({
    manual: input.manualWholesale,
    square: input.squareWholesale,
    calculated: input.calculatedWholesale,
  })
  const retail = pickBest({
    manual: input.manualRetail,
    square: input.squareRetail,
    calculated: input.calculatedRetail,
  })

  const tiers = [wholesale.tier, retail.tier].filter((t): t is Tier => t !== null)

  let source: SalesSource = 'empty'
  if (tiers.length > 0) {
    const distinct = new Set(tiers)
    // Two channels drawn from different tiers is genuinely mixed, and so is a
    // month where only one channel has any figure at all — saying "manual" for
    // a month whose retail is simply missing would overstate how much is known.
    source = distinct.size > 1 || tiers.length < 2 ? 'mixed' : tiers[0]
  }

  return {
    wholesale: round2(wholesale.value),
    retail: round2(retail.value),
    source,
  }
}

function isNum(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))
}
