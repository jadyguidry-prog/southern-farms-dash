import type { BusinessSettings } from '@/lib/queries'
import { formatCurrency, formatPercent } from '@/lib/data'

/**
 * Shared health-scoring logic. Every threshold comes from the owner's stored
 * business_settings — nothing in here is hardcoded.
 *
 * "unknown" is used when the underlying data hasn't been entered yet, so an
 * empty table never masquerades as a passing (or failing) grade.
 */
export type HealthStatus = 'green' | 'yellow' | 'red' | 'unknown'

export type HealthResult = {
  status: HealthStatus
  /** Short status word for badges/cards. */
  label: string
  /** Plain-language explanation referencing the owner's own targets. */
  message: string
  /** 0-100 contribution to the composite score, or null when unknown. */
  score: number | null
}

export const HEALTH_LABEL: Record<HealthStatus, string> = {
  green: 'Healthy',
  yellow: 'Caution',
  red: 'At Risk',
  unknown: 'No Data',
}

/** Tailwind text color token for each status. */
export const HEALTH_TEXT: Record<HealthStatus, string> = {
  green: 'text-chart-3',
  yellow: 'text-chart-4',
  red: 'text-destructive',
  unknown: 'text-muted-foreground',
}

/** CSS var for chart fills. */
export const HEALTH_COLOR: Record<HealthStatus, string> = {
  green: 'var(--chart-3)',
  yellow: 'var(--chart-4)',
  red: 'var(--destructive)',
  unknown: 'var(--muted-foreground)',
}

/**
 * Payroll as a share of sales.
 * Green below target, yellow from target up to the warning, red at/above warning.
 */
export function payrollHealth(
  payrollPct: number,
  settings: Pick<BusinessSettings, 'target_payroll_pct' | 'warning_payroll_pct'>,
  hasData = true,
): HealthResult {
  const { target_payroll_pct: target, warning_payroll_pct: warning } = settings

  if (!hasData || payrollPct <= 0) {
    return {
      status: 'unknown',
      label: HEALTH_LABEL.unknown,
      message: 'Add payroll and sales data to evaluate payroll health.',
      score: null,
    }
  }

  if (payrollPct >= warning) {
    return {
      status: 'red',
      label: HEALTH_LABEL.red,
      message: `Payroll is ${formatPercent(payrollPct)} of sales — at or above your ${formatPercent(warning, 0)} warning threshold.`,
      score: 35,
    }
  }

  if (payrollPct >= target) {
    return {
      status: 'yellow',
      label: HEALTH_LABEL.yellow,
      message: `Payroll is ${formatPercent(payrollPct)} of sales — over your ${formatPercent(target, 0)} target but under the ${formatPercent(warning, 0)} warning line.`,
      score: 70,
    }
  }

  return {
    status: 'green',
    label: HEALTH_LABEL.green,
    message: `Payroll is ${formatPercent(payrollPct)} of sales — below your ${formatPercent(target, 0)} target.`,
    score: 100,
  }
}

/**
 * Projected cash measured against the minimum reserve.
 * Green at/above reserve, yellow from 75% to 99%, red below 75%.
 */
export function cashReserveHealth(
  projectedCash: number,
  settings: Pick<BusinessSettings, 'min_cash_reserve'>,
  hasData = true,
): HealthResult {
  const reserve = settings.min_cash_reserve

  if (!hasData || reserve <= 0) {
    return {
      status: 'unknown',
      label: HEALTH_LABEL.unknown,
      message: 'Enter your account balances to evaluate cash health.',
      score: null,
    }
  }

  const ratio = projectedCash / reserve

  if (ratio >= 1) {
    return {
      status: 'green',
      label: HEALTH_LABEL.green,
      message: `Projected cash of ${formatCurrency(projectedCash)} is at or above your ${formatCurrency(reserve)} minimum reserve.`,
      score: 100,
    }
  }

  if (ratio >= 0.75) {
    return {
      status: 'yellow',
      label: HEALTH_LABEL.yellow,
      message: `Projected cash of ${formatCurrency(projectedCash)} is within 25% of your ${formatCurrency(reserve)} minimum reserve.`,
      score: 70,
    }
  }

  return {
    status: 'red',
    label: HEALTH_LABEL.red,
    message: `Projected cash of ${formatCurrency(projectedCash)} is below 75% of your ${formatCurrency(reserve)} minimum reserve.`,
    score: 30,
  }
}

/**
 * Weekly sales measured against the preferred goal and the minimum floor.
 * Green at/above preferred, yellow from minimum up to preferred, red below minimum.
 */
export function weeklySalesHealth(
  weeklySales: number,
  settings: Pick<BusinessSettings, 'minimum_weekly_sales' | 'preferred_weekly_sales'>,
  hasData = true,
): HealthResult {
  const { minimum_weekly_sales: floor, preferred_weekly_sales: goal } = settings

  if (!hasData || weeklySales <= 0) {
    return {
      status: 'unknown',
      label: HEALTH_LABEL.unknown,
      message: 'Enter weekly sales to evaluate sales health.',
      score: null,
    }
  }

  if (weeklySales >= goal) {
    return {
      status: 'green',
      label: HEALTH_LABEL.green,
      message: `Weekly sales of ${formatCurrency(weeklySales)} meet your ${formatCurrency(goal)} preferred target.`,
      score: 100,
    }
  }

  if (weeklySales >= floor) {
    return {
      status: 'yellow',
      label: HEALTH_LABEL.yellow,
      message: `Weekly sales of ${formatCurrency(weeklySales)} clear your ${formatCurrency(floor)} floor but fall short of the ${formatCurrency(goal)} goal.`,
      score: 70,
    }
  }

  return {
    status: 'red',
    label: HEALTH_LABEL.red,
    message: `Weekly sales of ${formatCurrency(weeklySales)} are below your ${formatCurrency(floor)} minimum target.`,
    score: 30,
  }
}

export type HealthPillars = {
  payroll: HealthResult
  cash: HealthResult
  sales: HealthResult
}

export type CompositeHealth = {
  /** Composite 0-100 score, or null when no pillar has data. */
  score: number | null
  status: HealthStatus
  label: string
  /** How many pillars actually contributed. */
  measured: number
  total: number
}

/**
 * Composite Business Health Score — the average of whichever pillars have data.
 * A single red pillar caps the overall status at "At Risk" so a strong average
 * can't hide a serious problem.
 */
export function compositeHealth(pillars: HealthPillars): CompositeHealth {
  const all = [pillars.payroll, pillars.cash, pillars.sales]
  const scored = all.filter((p) => p.score !== null)

  if (scored.length === 0) {
    return {
      score: null,
      status: 'unknown',
      label: HEALTH_LABEL.unknown,
      measured: 0,
      total: all.length,
    }
  }

  const score = Math.round(
    scored.reduce((sum, p) => sum + (p.score ?? 0), 0) / scored.length,
  )

  let status: HealthStatus
  if (all.some((p) => p.status === 'red')) {
    status = 'red'
  } else if (all.some((p) => p.status === 'yellow')) {
    status = 'yellow'
  } else {
    status = 'green'
  }

  return {
    score,
    status,
    label: HEALTH_LABEL[status],
    measured: scored.length,
    total: all.length,
  }
}

// ---------- Advisor insight generation ----------

export type Insight = {
  id: string
  severity: 'critical' | 'warning' | 'opportunity'
  category: string
  title: string
  detail: string
  impact: string
}

/**
 * Square point-of-sale figures for advisor insights.
 *
 * Optional throughout: when Square is not connected these stay undefined and no
 * Square insights are produced, rather than insights built on zeros.
 */
export type SquareInsightInput = {
  /** Trailing-week net sales, null when Square has no data. */
  weeklyNetSales?: number | null
  priorWeeklyNetSales?: number | null
  /** Totals across all recorded Square history. */
  totalNetSales?: number | null
  totalRefunds?: number
  totalProcessingFees?: number
  /** Most recent day Square has data for, used to detect a stale feed. */
  latestDate?: string | null
  /** Days where two sources disagreed, surfaced as a data-quality warning. */
  conflictDayCount?: number
}

/**
 * Bank-derived cash movement for advisor insights.
 *
 * Optional throughout, like the Square group: with no imported transactions
 * these stay undefined and no cash-flow insights are produced, rather than
 * insights asserted from zeros.
 */
export type CashFlowInsightInput = {
  /** Newest month having both deposits and spending. */
  latestCompleteMonth?: {
    month: string
    inflow: number
    outflow: number
    net: number
  } | null
  /** Largest identified outflow destination. */
  topPayee?: { payee: string; amount: number; share: number } | null
  /** Spend the bank never attributed to a payee, e.g. plain `CHECK` lines. */
  unidentifiedOutflow?: { amount: number; count: number; share: number } | null
  /** Share of spend carrying a category, measured in dollars. */
  categoryCoverage?: number | null
  /** Months present but missing their deposit account. */
  incompleteMonthCount?: number
  /** Categories that look like income but sit on expense rows. */
  mistypedCategoryCount?: number
}

/**
 * Timecard-derived labor facts the advisor can act on. Separate from the
 * payroll pillar because these are data-quality and scheduling issues, not
 * ratio-versus-target judgements.
 */
export type LaborInsightInput = {
  /** Labor as a share of net sales for the latest COMPLETE month. */
  laborPct: number | null
  monthLabel: string | null
  /**
   * Dollar-weighted ratios over wider windows, for trend context. Optional so a
   * caller with only a single complete month produces no trend claim.
   */
  rolling3Pct?: number | null
  rolling3Months?: number
  allTimePct?: number | null
  allTimeMonths?: number
  estimatedGrossLabor: number
  payableHours: number
  overtimeHours: number
  estimatedOvertimeCost: number
  /** Hours with no wage on file — they make every labor figure a floor. */
  unpricedHours: number
  unpricedShifts: number
  /** Who the unpriced hours belong to, so the owner knows where to look. */
  unpricedBy: { label: string; hours: number }[]
  /** Shifts long enough to imply a forgotten clock-out. */
  likelyMissedClockOuts: number
  salesPerLaborHour: number | null
}

type InsightInput = {
  settings: BusinessSettings
  pillars: HealthPillars
  /** Obligations still missing a due date, so scheduling can't be projected. */
  obligationsMissingDueDate?: { name: string; amount: number }[]
  overdueObligations?: number
  square?: SquareInsightInput
  cashFlow?: CashFlowInsightInput
  /** Omit entirely when no timecards exist, so no labor insights are made up. */
  labor?: LaborInsightInput
  /** Injectable clock so staleness tests are deterministic. */
  now?: Date
}

/**
 * Generate advisor warnings and positive notes directly from the owner's stored
 * thresholds. These sit alongside any manually entered recommendations.
 */
export function generateInsights({
  settings,
  pillars,
  obligationsMissingDueDate = [],
  overdueObligations = 0,
  square,
  cashFlow,
  labor,
  now,
}: InsightInput): Insight[] {
  const out: Insight[] = []
  const { payroll, cash, sales } = pillars

  // --- Cash reserve ---
  if (cash.status === 'red') {
    out.push({
      id: 'auto-cash-critical',
      severity: 'critical',
      category: 'Cash',
      title: 'Projected cash is well below your minimum reserve',
      detail: `${cash.message} Consider delaying non-essential spending, accelerating collections, or drawing on your line of credit to rebuild the buffer.`,
      impact: `Reserve target ${formatCurrency(settings.min_cash_reserve)}`,
    })
  } else if (cash.status === 'yellow') {
    out.push({
      id: 'auto-cash-warning',
      severity: 'warning',
      category: 'Cash',
      title: 'Cash is approaching your minimum reserve',
      detail: `${cash.message} Watch upcoming obligations closely over the next two weeks.`,
      impact: `Reserve target ${formatCurrency(settings.min_cash_reserve)}`,
    })
  } else if (cash.status === 'green') {
    out.push({
      id: 'auto-cash-ok',
      severity: 'opportunity',
      category: 'Cash',
      title: 'Cash reserve is holding above target',
      detail: `${cash.message} You have room to invest in inventory or equipment without dipping into credit.`,
      impact: `Reserve target ${formatCurrency(settings.min_cash_reserve)}`,
    })
  }

  // --- Payroll ---
  if (payroll.status === 'red') {
    out.push({
      id: 'auto-payroll-critical',
      severity: 'critical',
      category: 'Payroll',
      title: 'Payroll has crossed your warning threshold',
      detail: `${payroll.message} Review scheduled hours and overtime, or grow sales to bring the ratio back under your ${formatPercent(settings.target_payroll_pct, 0)} target.`,
      impact: `Target ${formatPercent(settings.target_payroll_pct, 0)} of sales`,
    })
  } else if (payroll.status === 'yellow') {
    out.push({
      id: 'auto-payroll-warning',
      severity: 'warning',
      category: 'Payroll',
      title: 'Payroll is running over target',
      detail: `${payroll.message} Trimming hours now keeps you from crossing the ${formatPercent(settings.warning_payroll_pct, 0)} warning line.`,
      impact: `Target ${formatPercent(settings.target_payroll_pct, 0)} of sales`,
    })
  } else if (payroll.status === 'green') {
    out.push({
      id: 'auto-payroll-ok',
      severity: 'opportunity',
      category: 'Payroll',
      title: 'Payroll is under your target',
      detail:
        labor && labor.unpricedHours >= 1
          ? `${payroll.message} Treat this as provisional: ${Math.round(labor.unpricedHours).toLocaleString()} worked hours have no wage on file, so the true ratio is higher than shown.`
          : `${payroll.message} Labor efficiency is working in your favor this period.`,
      impact: `Target ${formatPercent(settings.target_payroll_pct, 0)} of sales`,
    })
  }

  /*
   * --- Labor (from Square timecards) ---
   * Data-quality issues come first: an unpriced hour or a forgotten clock-out
   * distorts every labor number above, so the owner needs to know the ratio is
   * a floor before acting on it.
   */
  if (labor) {
    if (labor.unpricedHours >= 1) {
      const who = labor.unpricedBy
        .slice(0, 3)
        .map((u) => `${u.label} (${Math.round(u.hours).toLocaleString()} h)`)
        .join(', ')
      out.push({
        id: 'auto-labor-unpriced',
        severity: 'warning',
        category: 'Payroll',
        title: 'Some worked hours have no wage on file',
        detail: `${Math.round(labor.unpricedHours).toLocaleString()} payable hours across ${labor.unpricedShifts} shifts are costed at $0 because Square has no hourly rate for them${who ? `: ${who}` : ''}. Every labor total and payroll percentage is therefore a floor, not the real figure. Adding rates in Square — or recording owner pay separately if these are draws rather than wages — will make the ratio trustworthy.`,
        impact: `${Math.round(labor.unpricedHours).toLocaleString()} h uncosted`,
      })
    }

    if (labor.likelyMissedClockOuts > 0) {
      out.push({
        id: 'auto-labor-missed-clockouts',
        severity: 'warning',
        category: 'Payroll',
        title: 'Several shifts look like missed clock-outs',
        detail: `${labor.likelyMissedClockOuts} shifts ran long enough to suggest someone forgot to clock out. Each one inflates recorded hours and overstates labor cost. Correcting them in Square will tighten both the payroll ratio and the sales-per-labor-hour figure.`,
        impact: `${labor.likelyMissedClockOuts} shifts to review`,
      })
    }

    if (labor.overtimeHours >= 1) {
      out.push({
        id: 'auto-labor-overtime',
        severity: labor.estimatedOvertimeCost >= 1000 ? 'warning' : 'opportunity',
        category: 'Payroll',
        title: 'Overtime is adding a premium to payroll',
        detail: `About ${Math.round(labor.overtimeHours).toLocaleString()} hours were worked past 40 in a week, carrying an estimated ${formatCurrency(labor.estimatedOvertimeCost)} in half-time premium. Spreading those hours across more staff, or shifting them earlier in the week, converts most of that premium back into regular pay.`,
        impact: `${formatCurrency(labor.estimatedOvertimeCost)} premium`,
      })
    }

    /*
     * Trend across the three windows. A single month can be dismissed as noise
     * and a long average can hide a climb; comparing them is what distinguishes
     * the two. Requires at least 2 months in the rolling window so "the trend"
     * is never asserted from one data point.
     */
    if (
      labor.laborPct != null &&
      labor.rolling3Pct != null &&
      labor.allTimePct != null &&
      (labor.rolling3Months ?? 0) >= 2 &&
      (labor.allTimeMonths ?? 0) > (labor.rolling3Months ?? 0)
    ) {
      const recentVsAll = labor.rolling3Pct - labor.allTimePct
      const monthVsRecent = labor.laborPct - labor.rolling3Pct
      // One point of payroll ratio is material on a shop this size; below that
      // the windows are effectively flat and no trend claim is warranted.
      if (recentVsAll >= 1) {
        out.push({
          id: 'auto-labor-trend-up',
          severity: 'warning',
          category: 'Payroll',
          title: 'Labor is a growing share of sales, not a one-month blip',
          detail: `The last ${labor.rolling3Months} complete months ran ${formatPercent(labor.rolling3Pct)} of sales against ${formatPercent(labor.allTimePct)} across all ${labor.allTimeMonths} months — ${formatPercent(recentVsAll)} higher. ${labor.monthLabel} alone was ${formatPercent(labor.laborPct)}${Math.abs(monthVsRecent) >= 1 ? `, ${monthVsRecent > 0 ? 'above' : 'below'} even the recent run` : ', in line with the recent run'}. Because the wider window moved too, this is a direction of travel rather than one unusual month, so it is worth addressing at the scheduling level instead of waiting for it to correct itself.`,
          impact: `${formatPercent(recentVsAll)} above the long-run rate`,
        })
      } else if (recentVsAll <= -1) {
        out.push({
          id: 'auto-labor-trend-down',
          severity: 'opportunity',
          category: 'Payroll',
          title: 'Labor is a shrinking share of sales',
          detail: `The last ${labor.rolling3Months} complete months ran ${formatPercent(labor.rolling3Pct)} of sales against ${formatPercent(labor.allTimePct)} across all ${labor.allTimeMonths} months — ${formatPercent(Math.abs(recentVsAll))} lower. ${labor.monthLabel} came in at ${formatPercent(labor.laborPct)}. Whatever changed in scheduling or sales mix is working; worth identifying so it can be kept.`,
          impact: `${formatPercent(Math.abs(recentVsAll))} below the long-run rate`,
        })
      } else if (Math.abs(monthVsRecent) >= 1) {
        // Wider window flat but the month diverges — the opposite reading, and
        // the one where reacting to a single month would be a mistake.
        out.push({
          id: 'auto-labor-month-outlier',
          severity: 'opportunity',
          category: 'Payroll',
          title: `${labor.monthLabel} sits apart from an otherwise steady trend`,
          detail: `${labor.monthLabel} ran ${formatPercent(labor.laborPct)} of sales while the last ${labor.rolling3Months} months averaged ${formatPercent(labor.rolling3Pct)} and the full ${labor.allTimeMonths}-month record ${formatPercent(labor.allTimePct)}. The wider windows barely moved, so this looks like a single-month swing — a slow sales week or a one-off schedule — rather than a shift worth restructuring around. Worth a look before acting on it.`,
          impact: `${formatPercent(Math.abs(monthVsRecent))} vs recent months`,
        })
      }
    }

    if (labor.salesPerLaborHour != null && labor.monthLabel) {
      out.push({
        id: 'auto-labor-sales-per-hour',
        severity: 'opportunity',
        category: 'Payroll',
        title: 'Sales per labor hour is measurable',
        detail: `In ${labor.monthLabel} the shop produced ${formatCurrency(labor.salesPerLaborHour)} of net sales for every payable labor hour. Tracking this alongside the payroll percentage separates "we spent more on labor" from "labor became less productive" — the two call for very different responses.`,
        impact: `${formatCurrency(labor.salesPerLaborHour)} per labor hour`,
      })
    }
  }

  // --- Weekly sales ---
  if (sales.status === 'red') {
    out.push({
      id: 'auto-sales-critical',
      severity: 'critical',
      category: 'Sales',
      title: 'Weekly sales are below your minimum target',
      detail: `${sales.message} Consider a promotion, outreach to wholesale accounts, or extended hours to close the gap.`,
      impact: `Floor ${formatCurrency(settings.minimum_weekly_sales)}`,
    })
  } else if (sales.status === 'yellow') {
    out.push({
      id: 'auto-sales-warning',
      severity: 'warning',
      category: 'Sales',
      title: 'Weekly sales are short of your preferred target',
      detail: `${sales.message} You are above the floor, so a modest lift gets you to goal.`,
      impact: `Goal ${formatCurrency(settings.preferred_weekly_sales)}`,
    })
  } else if (sales.status === 'green') {
    out.push({
      id: 'auto-sales-ok',
      severity: 'opportunity',
      category: 'Sales',
      title: 'Weekly sales are meeting your preferred target',
      detail: `${sales.message} Keep the current mix and staffing steady.`,
      impact: `Goal ${formatCurrency(settings.preferred_weekly_sales)}`,
    })
  }

  // --- Scheduling data quality ---
  if (obligationsMissingDueDate.length > 0) {
    const names = obligationsMissingDueDate.map((o) => o.name).join(', ')
    const total = obligationsMissingDueDate.reduce((s, o) => s + o.amount, 0)
    out.push({
      id: 'auto-missing-due-dates',
      severity: 'warning',
      category: 'Setup',
      title: `${obligationsMissingDueDate.length} recurring ${
        obligationsMissingDueDate.length === 1 ? 'obligation needs' : 'obligations need'
      } a due date`,
      detail: `${names} ${obligationsMissingDueDate.length === 1 ? 'has' : 'have'} no due date, so ${formatCurrency(total)} is excluded from your 7, 14, and 30-day cash projections. Add due dates on the Cash & Debt page to make those forecasts accurate.`,
      impact: `${formatCurrency(total)} unscheduled`,
    })
  }

  if (overdueObligations > 0) {
    out.push({
      id: 'auto-overdue',
      severity: 'critical',
      category: 'Obligations',
      title: `${overdueObligations} obligation${overdueObligations === 1 ? '' : 's'} past due`,
      detail: `You have ${overdueObligations} unpaid obligation${overdueObligations === 1 ? '' : 's'} with a due date in the past. Clearing or rescheduling ${overdueObligations === 1 ? 'it' : 'them'} keeps vendor terms and your forecast accurate.`,
      impact: 'Vendor standing',
    })
  }

  // --- Square point of sale ---
  // Every branch below requires a real figure. Square being connected but empty
  // must not manufacture insights about $0 of sales.
  if (square) {
    const {
      weeklyNetSales,
      priorWeeklyNetSales,
      totalNetSales,
      totalRefunds = 0,
      totalProcessingFees = 0,
      latestDate,
      conflictDayCount = 0,
    } = square

    // Week-over-week movement, only when both weeks have real data.
    if (
      weeklyNetSales != null &&
      priorWeeklyNetSales != null &&
      priorWeeklyNetSales > 0
    ) {
      const delta =
        ((weeklyNetSales - priorWeeklyNetSales) / priorWeeklyNetSales) * 100
      if (delta <= -15) {
        out.push({
          id: 'auto-square-week-down',
          severity: 'warning',
          category: 'Sales',
          title: `Register sales fell ${Math.abs(delta).toFixed(0)}% versus the prior week`,
          detail: `Square recorded ${formatCurrency(weeklyNetSales)} this week against ${formatCurrency(priorWeeklyNetSales)} the week before. Check whether this is seasonal, a staffing gap, or stock running out on your best sellers.`,
          impact: `${formatCurrency(priorWeeklyNetSales - weeklyNetSales)} lower`,
        })
      } else if (delta >= 15) {
        out.push({
          id: 'auto-square-week-up',
          severity: 'opportunity',
          category: 'Sales',
          title: `Register sales rose ${delta.toFixed(0)}% versus the prior week`,
          detail: `Square recorded ${formatCurrency(weeklyNetSales)} this week against ${formatCurrency(priorWeeklyNetSales)} the week before. Worth noting what drove it so you can repeat it.`,
          impact: `${formatCurrency(weeklyNetSales - priorWeeklyNetSales)} higher`,
        })
      }
    }

    // Refund rate, as a share of net sales.
    if (totalNetSales != null && totalNetSales > 0 && totalRefunds > 0) {
      const refundRate = (totalRefunds / totalNetSales) * 100
      if (refundRate >= 5) {
        out.push({
          id: 'auto-square-refunds',
          severity: 'warning',
          category: 'Sales',
          title: `Refunds are ${refundRate.toFixed(1)}% of Square sales`,
          detail: `${formatCurrency(totalRefunds)} has been refunded against ${formatCurrency(totalNetSales)} in net sales. A rate this high usually points to a product quality issue, a pricing error at the register, or repeated mis-rings.`,
          impact: `${formatCurrency(totalRefunds)} refunded`,
        })
      }
    }

    // Card processing cost, which is easy to overlook because Square nets it out.
    if (totalNetSales != null && totalNetSales > 0 && totalProcessingFees > 0) {
      const feeRate = (totalProcessingFees / totalNetSales) * 100
      if (feeRate >= 3.5) {
        out.push({
          id: 'auto-square-fees',
          severity: 'warning',
          category: 'Sales',
          title: `Card processing is costing ${feeRate.toFixed(2)}% of sales`,
          detail: `You have paid ${formatCurrency(totalProcessingFees)} in Square processing fees on ${formatCurrency(totalNetSales)} of net sales. Above roughly 3.5% it is worth reviewing your Square plan or encouraging cash on small purchases.`,
          impact: `${formatCurrency(totalProcessingFees)} in fees`,
        })
      }
    }

    // A feed that has quietly stopped is worse than no feed, because the
    // dashboard keeps showing an old number as if it were current.
    if (latestDate) {
      const reference = now ?? new Date()
      const last = new Date(`${latestDate}T00:00:00Z`)
      const daysBehind = Math.floor(
        (reference.getTime() - last.getTime()) / 86_400_000,
      )
      if (daysBehind >= 7) {
        out.push({
          id: 'auto-square-stale',
          severity: daysBehind >= 30 ? 'critical' : 'warning',
          category: 'Setup',
          title: `Square sales data is ${daysBehind} days behind`,
          detail: `The most recent Square sale on record is from ${latestDate}. Any sales since then are missing from your dashboard and reports. Run a sync from Settings, or import a fresh CSV export.`,
          impact: `${daysBehind} days missing`,
        })
      }
    }

    if (conflictDayCount > 0) {
      out.push({
        id: 'auto-square-conflicts',
        severity: 'warning',
        category: 'Setup',
        title: `${conflictDayCount} day${conflictDayCount === 1 ? '' : 's'} of Square sales disagree between sources`,
        detail: `For ${conflictDayCount} day${conflictDayCount === 1 ? '' : 's'}, the live Square sync and an imported CSV report different totals. The live sync is used, and each day is only counted once, but the mismatch is worth a look — it usually means the CSV covered a partial day.`,
        impact: 'Data accuracy',
      })
    }
  }

  // --- Bank cash flow ---
  if (cashFlow) {
    const {
      latestCompleteMonth,
      topPayee,
      unidentifiedOutflow,
      categoryCoverage,
      incompleteMonthCount = 0,
      mistypedCategoryCount = 0,
    } = cashFlow

    // Net movement for the newest trustworthy month. A card-only month is
    // deliberately excluded upstream, since it shows spending with no deposits
    // and would read as a total loss.
    if (latestCompleteMonth) {
      const { month, inflow, outflow, net } = latestCompleteMonth
      if (net < 0) {
        out.push({
          id: 'auto-cashflow-negative',
          severity: 'warning',
          category: 'Cash',
          title: `${month} spent ${formatCurrency(Math.abs(net))} more than it took in`,
          detail: `Bank activity for ${month} shows ${formatCurrency(inflow)} in and ${formatCurrency(outflow)} out. One month of negative movement isn't necessarily a problem, but repeated months draw down the cash reserve.`,
          impact: `Net ${formatCurrency(net)} in ${month}`,
        })
      } else {
        out.push({
          id: 'auto-cashflow-positive',
          severity: 'opportunity',
          category: 'Cash',
          title: `${month} finished cash positive`,
          detail: `Bank activity for ${month} shows ${formatCurrency(inflow)} in against ${formatCurrency(outflow)} out, adding ${formatCurrency(net)} to cash.`,
          impact: `Net ${formatCurrency(net)} in ${month}`,
        })
      }
    }

    // Concentration risk: one payee taking an outsized share of spend.
    if (topPayee && topPayee.share >= 0.1) {
      out.push({
        id: 'auto-cashflow-top-payee',
        severity: topPayee.share >= 0.25 ? 'warning' : 'opportunity',
        category: 'Cash',
        title: `${topPayee.payee} is ${formatPercent(topPayee.share * 100, 0)} of identified spending`,
        detail: `${formatCurrency(topPayee.amount)} has gone to ${topPayee.payee}. A supplier this large is worth a pricing or terms conversation, and concentration is a risk if they raise prices.`,
        impact: `${formatCurrency(topPayee.amount)} total`,
      })
    }

    // The honest ceiling on this whole module: unattributed spend.
    if (unidentifiedOutflow && unidentifiedOutflow.share >= 0.2) {
      out.push({
        id: 'auto-cashflow-unidentified',
        severity: 'warning',
        category: 'Setup',
        title: `${formatPercent(unidentifiedOutflow.share * 100, 0)} of spending has no identifiable payee`,
        detail: `${formatCurrency(unidentifiedOutflow.amount)} across ${unidentifiedOutflow.count} transactions is described only as a check or generic withdrawal, so no rule can attribute it automatically. Your bank export carries no payee or check number for these. Reconciling them against check stubs is the only way to see where that money actually went.`,
        impact: `${formatCurrency(unidentifiedOutflow.amount)} unattributed`,
      })
    }

    if (categoryCoverage != null && categoryCoverage < 0.8) {
      out.push({
        id: 'auto-cashflow-coverage',
        severity: 'opportunity',
        category: 'Setup',
        title: `Only ${formatPercent(categoryCoverage * 100, 0)} of spending is categorized`,
        detail: `Category totals cover ${formatPercent(categoryCoverage * 100, 0)} of dollars spent, so the breakdown is partial. Assigning categories to your largest vendors lifts coverage fastest, since spending is concentrated in a handful of payees.`,
        impact: 'Reporting completeness',
      })
    }

    if (incompleteMonthCount > 0) {
      out.push({
        id: 'auto-cashflow-incomplete-months',
        severity: 'warning',
        category: 'Setup',
        title: `${incompleteMonthCount} month${incompleteMonthCount === 1 ? ' is' : 's are'} missing bank deposits`,
        detail: `${incompleteMonthCount} month${incompleteMonthCount === 1 ? ' has' : 's have'} card activity but no deposit account imported, so ${incompleteMonthCount === 1 ? 'it shows' : 'they show'} spending with no income. Importing the matching checking statements will correct those months.`,
        impact: 'Data completeness',
      })
    }

    if (mistypedCategoryCount > 0) {
      out.push({
        id: 'auto-cashflow-mistyped',
        severity: 'opportunity',
        category: 'Setup',
        title: `${mistypedCategoryCount} income categor${mistypedCategoryCount === 1 ? 'y is' : 'ies are'} attached to expense rows`,
        detail: `Some transactions are typed as expenses but carry an income category such as a sales deposit. They are still counted as spending, because the imported transaction type is what decides direction and nothing is changed automatically. If they are really deposits, correcting the transaction type on the Vendors page will lower reported spend.`,
        impact: 'Data accuracy',
      })
    }
  }

  return out
}

/**
 * Advance a date by one recurrence interval. Used to project the next due date
 * for recurring obligations.
 */
export function addInterval(date: Date, frequency: string): Date {
  const d = new Date(date)
  switch (frequency) {
    case 'Weekly':
      d.setDate(d.getDate() + 7)
      break
    case 'Biweekly':
      d.setDate(d.getDate() + 14)
      break
    case 'Quarterly':
      d.setMonth(d.getMonth() + 3)
      break
    case 'Annually':
      d.setFullYear(d.getFullYear() + 1)
      break
    default: // Monthly
      d.setMonth(d.getMonth() + 1)
  }
  return d
}

/**
 * The effective next due date for an obligation: an explicit next_due_date wins,
 * otherwise roll the base due date forward by its frequency until it is not in
 * the past. Returns an ISO date string, or '' when nothing is scheduled.
 */
export function resolveNextDueDate(
  o: { dueDate: string; nextDueDate?: string; recurring: boolean; frequency: string },
  today: Date,
): string {
  if (o.nextDueDate) return o.nextDueDate
  if (!o.dueDate) return ''
  if (!o.recurring) return o.dueDate

  let d = new Date(o.dueDate + 'T00:00:00')
  // Cap iterations so a bad frequency can never spin forever.
  for (let i = 0; i < 400 && d < today; i++) {
    d = addInterval(d, o.frequency || 'Monthly')
  }
  return d.toISOString().slice(0, 10)
}
