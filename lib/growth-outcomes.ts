/**
 * Forecast-vs-actual comparison for activated growth commitments. PURE: no I/O, no
 * clock, no server APIs, so it is client-safe and the verify script exercises the
 * exact code the pages render.
 *
 * Three rules drive every decision in here, and all three are about not flattering
 * the numbers:
 *
 *  1. An unrecorded month is NOT a free month. Missing cost is `null`, never 0, and
 *     forecast totals are summed over RECORDED months only — otherwise a commitment
 *     you simply haven't logged yet would appear to be running under budget.
 *
 *  2. Recorded revenue is SALES, but the proposal's break-even is stated in GROSS
 *     PROFIT (because this business has no margin we trust). Comparing the two
 *     directly would overstate performance enormously — $2,400 of sales against an
 *     $800 profit break-even looks like 3x, when at a 30% margin it is $720 of
 *     profit and actually below break-even. So sales are only ever compared against
 *     the required-sales figures from the proposal's own margin sensitivity table.
 *
 *  3. Revenue with no defensible attribution is not evidence. A figure the owner
 *     flagged as merely correlated is reported as such and never silently added to
 *     an "it earned this much" total.
 */

import { addMonths, monthKeyOf, monthsBetween } from '@/lib/month-key'

/** How defensible a recorded revenue figure is. */
export type Attribution =
  | 'attributed'
  | 'partially_attributed'
  | 'correlated_only'
  | 'not_measurable'

export const ATTRIBUTION_LABELS: Record<Attribution, string> = {
  attributed: 'Directly attributed',
  partially_attributed: 'Partly attributed',
  correlated_only: 'Correlated only',
  not_measurable: 'Not measurable',
}

/** Plain-language note on how much weight a figure deserves. */
export const ATTRIBUTION_CAVEATS: Record<Attribution, string> = {
  attributed: 'Traceable to this commitment.',
  partially_attributed: 'Partly driven by this, partly by other things.',
  correlated_only: 'Happened alongside this, but not shown to be caused by it.',
  not_measurable: 'No way to tell what this commitment contributed.',
}

/** Attribution levels strong enough to treat revenue as evidence of a return. */
const DEFENSIBLE: Attribution[] = ['attributed', 'partially_attributed']

export function isDefensible(a: Attribution): boolean {
  return DEFENSIBLE.includes(a)
}

/** Weakest (least defensible) attribution wins, so a summary can't hide a weak month. */
const ATTRIBUTION_STRENGTH: Record<Attribution, number> = {
  attributed: 3,
  partially_attributed: 2,
  correlated_only: 1,
  not_measurable: 0,
}

export type ActivationRecord = {
  actualStartDate: string
  actualUpfrontCost: number
  notes: string | null
}

export type OutcomeRecord = {
  monthKey: string
  /** `null` = not recorded yet. Never coerce to 0. */
  actualCost: number | null
  /** Added SALES attributed to this commitment. `null` = not measured. */
  revenueImpact: number | null
  attribution: Attribution
  notes: string | null
}

export type MonthComparison = {
  monthKey: string
  forecastCost: number
  actualCost: number | null
  /** Actual minus forecast. Positive = over budget. `null` when not recorded. */
  costVariance: number | null
  revenueImpact: number | null
  attribution: Attribution
  recorded: boolean
}

/** What the recorded sales would need to be to break even, at an assumed margin. */
export type MarginCheck = {
  marginPct: number
  requiredMonthlySales: number
  /** Recorded sales cover break-even at this margin. */
  clears: boolean
}

export type OutcomeVerdict =
  | 'not_activated'
  | 'no_months_recorded'
  | 'cost_only'
  | 'revenue_not_defensible'
  | 'covering_at_all_margins'
  | 'covering_at_optimistic_margins'
  | 'not_covering'

export type OutcomeSummary = {
  activated: boolean
  activation: ActivationRecord | null
  /** Months from activation through `todayMonthKey`, inclusive. */
  monthsElapsed: number
  monthsRecorded: number
  /** Months that have elapsed but have no cost recorded. */
  monthsMissing: string[]
  /** Per-month rows from activation to today, recorded or not. */
  months: MonthComparison[]

  // --- Cost: forecast summed over RECORDED months only, for a fair comparison ---
  forecastMonthlyCost: number
  forecastUpfrontCost: number
  forecastCostOverRecorded: number
  actualCostOverRecorded: number | null
  costVariance: number | null
  costVariancePct: number | null
  upfrontVariance: number | null

  // --- Revenue: only ever from defensibly attributed months ---
  defensibleRevenue: number | null
  defensibleRevenueMonths: number
  /** Revenue recorded but too weakly attributed to count as a return. */
  nonDefensibleRevenue: number | null
  weakestAttribution: Attribution | null
  /** Average monthly defensible sales, for the margin checks. */
  avgMonthlyDefensibleRevenue: number | null
  marginChecks: MarginCheck[]

  verdict: OutcomeVerdict
  /** One honest sentence for the report and the detail page to share. */
  headline: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Compare what a commitment was forecast to cost against what it really did.
 *
 * `sensitivity` comes from the proposal's own ROI table (required monthly SALES at
 * assumed margins), so this never invents a margin of its own.
 */
export function summarizeOutcomes(input: {
  activation: ActivationRecord | null
  outcomes: OutcomeRecord[]
  forecastMonthlyCost: number
  forecastUpfrontCost: number
  /** Required monthly sales by assumed margin, from the proposal's ROI sensitivity. */
  sensitivity: { marginPct: number; requiredMonthlySales: number }[]
  /** `YYYY-MM` for today, passed in to keep this pure. */
  todayMonthKey: string
}): OutcomeSummary {
  const {
    activation,
    outcomes,
    forecastMonthlyCost,
    forecastUpfrontCost,
    sensitivity,
    todayMonthKey,
  } = input

  const empty: OutcomeSummary = {
    activated: false,
    activation: null,
    monthsElapsed: 0,
    monthsRecorded: 0,
    monthsMissing: [],
    months: [],
    forecastMonthlyCost,
    forecastUpfrontCost,
    forecastCostOverRecorded: 0,
    actualCostOverRecorded: null,
    costVariance: null,
    costVariancePct: null,
    upfrontVariance: null,
    defensibleRevenue: null,
    defensibleRevenueMonths: 0,
    nonDefensibleRevenue: null,
    weakestAttribution: null,
    avgMonthlyDefensibleRevenue: null,
    marginChecks: [],
    verdict: 'not_activated',
    headline:
      'Not started yet. Once this is live, record the month it began so its real cost can be tracked.',
  }

  if (!activation) return empty

  const startMonth = monthKeyOf(activation.actualStartDate)
  if (!startMonth) return empty

  // Elapsed months, inclusive of both the start month and the current one. Clamped
  // at 0 so a future start date reads as "not started" rather than negative months.
  const monthsElapsed = Math.max(0, monthsBetween(startMonth, todayMonthKey) + 1)

  const byMonth = new Map<string, OutcomeRecord>()
  for (const o of outcomes) byMonth.set(o.monthKey, o)

  const months: MonthComparison[] = []
  for (let i = 0; i < monthsElapsed; i++) {
    const monthKey = addMonths(startMonth, i)
    const rec = byMonth.get(monthKey)
    const actualCost = rec?.actualCost ?? null
    months.push({
      monthKey,
      forecastCost: forecastMonthlyCost,
      actualCost,
      costVariance: actualCost == null ? null : round2(actualCost - forecastMonthlyCost),
      revenueImpact: rec?.revenueImpact ?? null,
      attribution: rec?.attribution ?? 'not_measurable',
      recorded: actualCost != null,
    })
  }

  const recorded = months.filter((m) => m.recorded)
  const monthsMissing = months.filter((m) => !m.recorded).map((m) => m.monthKey)

  // Forecast is summed over recorded months ONLY. Summing it over every elapsed
  // month while actuals cover just a few would make any commitment look cheap.
  const forecastCostOverRecorded = round2(forecastMonthlyCost * recorded.length)
  const actualCostOverRecorded =
    recorded.length > 0 ? round2(recorded.reduce((s, m) => s + (m.actualCost ?? 0), 0)) : null
  const costVariance =
    actualCostOverRecorded == null
      ? null
      : round2(actualCostOverRecorded - forecastCostOverRecorded)
  const costVariancePct =
    costVariance == null || forecastCostOverRecorded === 0
      ? null
      : Math.round((costVariance / forecastCostOverRecorded) * 100)
  const upfrontVariance = round2(activation.actualUpfrontCost - forecastUpfrontCost)

  // Revenue is split by how defensible it is. Only defensible months roll up into a
  // return; the rest are reported separately so they cannot masquerade as evidence.
  const withRevenue = months.filter((m) => m.revenueImpact != null)
  const defensibleMonths = withRevenue.filter((m) => isDefensible(m.attribution))
  const weakMonths = withRevenue.filter((m) => !isDefensible(m.attribution))

  const defensibleRevenue =
    defensibleMonths.length > 0
      ? round2(defensibleMonths.reduce((s, m) => s + (m.revenueImpact ?? 0), 0))
      : null
  const nonDefensibleRevenue =
    weakMonths.length > 0
      ? round2(weakMonths.reduce((s, m) => s + (m.revenueImpact ?? 0), 0))
      : null

  const weakestAttribution =
    withRevenue.length > 0
      ? withRevenue.reduce<Attribution>(
          (worst, m) =>
            ATTRIBUTION_STRENGTH[m.attribution] < ATTRIBUTION_STRENGTH[worst]
              ? m.attribution
              : worst,
          'attributed',
        )
      : null

  const avgMonthlyDefensibleRevenue =
    defensibleRevenue != null && defensibleMonths.length > 0
      ? round2(defensibleRevenue / defensibleMonths.length)
      : null

  // Compare average recorded SALES against the required SALES at each assumed
  // margin — never against the gross-profit break-even figure.
  const marginChecks: MarginCheck[] =
    avgMonthlyDefensibleRevenue == null
      ? []
      : sensitivity.map((s) => ({
          marginPct: s.marginPct,
          requiredMonthlySales: s.requiredMonthlySales,
          clears: avgMonthlyDefensibleRevenue >= s.requiredMonthlySales,
        }))

  const { verdict, headline } = decide({
    recordedCount: recorded.length,
    monthsElapsed,
    costVariance,
    costVariancePct,
    actualCostOverRecorded,
    hasRevenue: withRevenue.length > 0,
    defensibleCount: defensibleMonths.length,
    avgMonthlyDefensibleRevenue,
    marginChecks,
    weakestAttribution,
  })

  return {
    activated: true,
    activation,
    monthsElapsed,
    monthsRecorded: recorded.length,
    monthsMissing,
    months,
    forecastMonthlyCost,
    forecastUpfrontCost,
    forecastCostOverRecorded,
    actualCostOverRecorded,
    costVariance,
    costVariancePct,
    upfrontVariance,
    defensibleRevenue,
    defensibleRevenueMonths: defensibleMonths.length,
    nonDefensibleRevenue,
    weakestAttribution,
    avgMonthlyDefensibleRevenue,
    marginChecks,
    verdict,
    headline,
  }
}

/** Pick the verdict and its one-sentence summary. Kept separate so it is testable. */
function decide(x: {
  recordedCount: number
  monthsElapsed: number
  costVariance: number | null
  costVariancePct: number | null
  actualCostOverRecorded: number | null
  hasRevenue: boolean
  defensibleCount: number
  avgMonthlyDefensibleRevenue: number | null
  marginChecks: MarginCheck[]
  weakestAttribution: Attribution | null
}): { verdict: OutcomeVerdict; headline: string } {
  if (x.recordedCount === 0) {
    return {
      verdict: 'no_months_recorded',
      headline:
        x.monthsElapsed === 1
          ? 'Live this month, with nothing recorded yet. Enter what it actually cost to start comparing against the forecast.'
          : `Live for ${x.monthsElapsed} months with no months recorded yet. Until costs are entered there is nothing to compare against the forecast.`,
    }
  }

  const costPart =
    x.costVariance == null || x.costVariancePct == null
      ? ''
      : x.costVariance === 0
        ? 'Costing exactly what was forecast.'
        : x.costVariance > 0
          ? `Costing ${x.costVariancePct}% more than forecast.`
          : `Costing ${Math.abs(x.costVariancePct)}% less than forecast.`

  if (!x.hasRevenue) {
    return {
      verdict: 'cost_only',
      headline: `${costPart} No revenue recorded against it yet, so whether it is paying for itself is still unknown.`.trim(),
    }
  }

  if (x.defensibleCount === 0) {
    return {
      verdict: 'revenue_not_defensible',
      headline:
        `${costPart} Revenue has been recorded, but only as ` +
        `${(ATTRIBUTION_LABELS[x.weakestAttribution ?? 'not_measurable'] ?? '').toLowerCase()}, ` +
        `so it is not evidence that this commitment caused it.`,
    }
  }

  const clearsAll = x.marginChecks.length > 0 && x.marginChecks.every((m) => m.clears)
  const clearsSome = x.marginChecks.some((m) => m.clears)

  if (clearsAll) {
    return {
      verdict: 'covering_at_all_margins',
      headline: `${costPart} Attributed sales cover its cost even at the most conservative margin tested.`,
    }
  }
  if (clearsSome) {
    // The honest middle case: whether this is paying off depends entirely on a
    // margin we do not actually know, so the copy must say so rather than pick one.
    const best = x.marginChecks.filter((m) => m.clears).map((m) => m.marginPct)
    return {
      verdict: 'covering_at_optimistic_margins',
      headline:
        `${costPart} Attributed sales only cover its cost if the margin is at least ` +
        `${Math.min(...best)}% — at lower margins it is still running at a loss.`,
    }
  }
  return {
    verdict: 'not_covering',
    headline: `${costPart} Attributed sales do not cover its cost at any of the margins tested.`,
  }
}
