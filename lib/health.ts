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
 *
 * The caller MUST pass a FULL seven-day window (the trailing week), never a
 * part-finished calendar week. The goal and floor are whole-week amounts, so a
 * Monday-only figure would be judged against a $17,000 floor and reported as a
 * severe shortfall on every Monday and Tuesday. The messages say "last 7 days"
 * explicitly because the dashboard card next to this shows calendar
 * week-to-date — two different windows, so each has to name its own.
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
      message: `Sales over the last 7 days of ${formatCurrency(weeklySales)} meet your ${formatCurrency(goal)} weekly target.`,
      score: 100,
    }
  }

  if (weeklySales >= floor) {
    return {
      status: 'yellow',
      label: HEALTH_LABEL.yellow,
      message: `Sales over the last 7 days of ${formatCurrency(weeklySales)} clear your ${formatCurrency(floor)} weekly floor but fall short of the ${formatCurrency(goal)} goal.`,
      score: 70,
    }
  }

  return {
    status: 'red',
    label: HEALTH_LABEL.red,
    message: `Sales over the last 7 days of ${formatCurrency(weeklySales)} are below your ${formatCurrency(floor)} weekly minimum.`,
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

/**
 * Unattributed CHECK payments and what they do to cost of goods.
 *
 * The bank export gives a check number and an amount but no payee, so these
 * dollars sit outside every category. Until they are attributed, COGS is a floor
 * and gross margin cannot be stated honestly — which is the whole point of
 * surfacing this to the advisor.
 */
export type CheckInsightInput = {
  pendingCount: number
  pendingAmount: number
  resolvedCount: number
  resolvedPctOfAmount: number
  /** Categorized COGS today, for the size comparison that makes the risk concrete. */
  baseCogsAmount: number
  /** unresolved ÷ categorized COGS. Above 1 means the unknown exceeds the known. */
  unresolvedVsCogsRatio: number | null
  /** True once the unresolved share is small enough to quote a margin. */
  grossProfitReady: boolean
  /** Largest same-amount groups, the fastest way to clear dollars. */
  topClusters: { amount: number; count: number; total: number; cadence: string | null }[]
  /**
   * Complete months with imported bank data and sales but no COGS categorized —
   * a genuine categorization gap.
   */
  monthsMissingCogs: string[]
  /**
   * Months with sales whose bank transactions were never imported. Separate from
   * `monthsMissingCogs` because the remedy differs: these need an import, not
   * categorization. Optional so existing callers keep working.
   */
  monthsMissingBankData?: string[]
  /**
   * How many unresolved checks carry a check number. Optional so existing
   * callers keep working. This matters because a numbered check can be looked up
   * directly in the bank portal, while one without a number has to be found by
   * date and amount — a materially harder job worth calling out separately.
   */
  withCheckNumberCount?: number
  /** Unresolved checks that already have a scan attached and are ready to name. */
  attachedCount?: number
}

/**
 * Marketing affordability facts, already computed by
 * `lib/marketing-affordability-service.ts`. Passed in rather than recomputed so
 * the Advisor can never contradict the Marketing Budget page.
 */
type MarketingInsightInput = {
  /** Recommended monthly marketing spend after every safety clamp. */
  recommended: number
  /** What is going out today (committed obligation or trailing actual). */
  current: number
  /**
   * Trailing 3-month average of spend actually CATEGORIZED as marketing. This is
   * the figure the owner sees on the page, so it is the one to name when
   * explaining that reported spend is too low — `current` can be the larger
   * committed obligation, which would point at the wrong number.
   */
  categorizedMonthly: number
  /** Headroom above the cash reserve; 0 or less means none. */
  additionalSafe: number
  band: string
  action: 'increase' | 'maintain' | 'reduce'
  summary: string
  blockers: string[]
  /** Negative when known bills exceed cash on hand. */
  reserveCoverage: number
  /** Set when the committed marketing line and actual spend disagree. */
  commitmentMismatch: { committed: number; actual: number; note: string } | null
  confidenceLabel: string
  seasonalLabel: string | null
  seasonalIndex: number | null
  /**
   * Advertising found in the ledger but never categorized as marketing, so it is
   * excluded from `current` and every figure on the Marketing page. The root
   * cause when reported spend looks far lower than the owner knows it is.
   */
  uncategorized: {
    total: number
    impliedMonthly: number
    topChannels: string[]
  } | null
  /**
   * Channels that billed regularly and then vanished from the bank feed. The
   * trailing average reads these as "stopped", which is wrong when they are still
   * being paid by a route the export carries no payee for (usually a check).
   */
  lapsedChannels: {
    channel: string
    lastDate: string
    monthsSinceLastCharge: number
    typicalMonthly: number
  }[]
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
  /** Omit when there are no CHECK lines, so no check insights are invented. */
  checks?: CheckInsightInput
  /**
   * Omit when there is no transaction or revenue history, so no marketing
   * budget is recommended from an empty database.
   */
  marketing?: MarketingInsightInput
  /**
   * Outstanding-check position. Omit when no payments have been recorded, so a
   * farm not yet using Bill Pay gets no bill-pay insights rather than zeros.
   */
  billPay?: BillPayInsightInput
  /** Injectable clock so staleness tests are deterministic. */
  now?: Date
}

export type BillPayInsightInput = {
  /** Written checks not yet cleared, in dollars. */
  outstandingChecks: number
  outstandingCheckCount: number
  /** Age in days of the oldest uncleared check, or null when none are outstanding. */
  oldestOutstandingDays: number | null
  /** Spendable cash after subtracting outstanding checks. */
  cashAvailable: number
  /** The owner's minimum cash reserve, for the "would this breach it" check. */
  minCashReserve: number
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
  checks,
  marketing,
  billPay,
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

  /*
   * Unattributed checks. These are reported as a COST-OF-GOODS trust problem
   * rather than a bookkeeping chore, because that is the decision they block:
   * every gross margin figure is unreliable while they are outstanding.
   */
  if (checks && checks.pendingCount > 0) {
    const ratio = checks.unresolvedVsCogsRatio
    out.push({
      id: 'auto-checks-unresolved',
      // Critical only when the unknown dollars exceed the known COGS — at that
      // point the margin is not merely imprecise, it is unknowable.
      severity: ratio != null && ratio >= 1 ? 'critical' : 'warning',
      category: 'Expenses',
      title:
        ratio != null && ratio >= 1
          ? 'Unattributed checks exceed all categorized cost of goods'
          : 'Unattributed checks are understating cost of goods',
      detail: `${checks.pendingCount} check payments totalling ${formatCurrency(checks.pendingAmount)} have no payee recorded — the bank export carries a check number and amount but no name, so these dollars sit in no category at all. Categorized cost of goods is ${formatCurrency(checks.baseCogsAmount)}${ratio != null ? `, so the unattributed amount is ${ratio.toFixed(1)}x the known figure` : ''}. Any gross margin calculated now would treat those checks as if they cost nothing, overstating profit. Resolving them on the Check Resolution screen is what turns gross profit into a number worth acting on.`,
      impact: `${formatCurrency(checks.pendingAmount)} unattributed`,
    })

    // Say concretely HOW to identify these, split by whether a check number
    // exists. A numbered check is a direct lookup in the bank portal; one without
    // a number has to be hunted by date and amount, so the two are not the same
    // job and lumping them together hides where the real effort is.
    if (checks.withCheckNumberCount != null) {
      const numbered = checks.withCheckNumberCount
      const unnumbered = Math.max(0, checks.pendingCount - numbered)
      const attached = checks.attachedCount ?? 0
      out.push({
        id: 'auto-checks-lookup-route',
        // Actionable guidance rather than a problem, so it reads as the route
        // forward instead of a second alarm about the same backlog.
        severity: 'opportunity',
        category: 'Expenses',
        title: 'How to identify the unnamed checks',
        detail: `The payee is only on the physical check, which the bank's CSV export never carried — that is why these are blank rather than anything being lost. ${numbered} of the ${checks.pendingCount} unresolved checks do carry a check number, so each can be looked up directly in the bank portal and the payee read off the scan.${unnumbered > 0 ? ` The remaining ${unnumbered} have no number and have to be found by date and amount instead.` : ''} Scans can be attached to each check on the Check Resolution screen, so the evidence stays on file once you have looked it up.${attached > 0 ? ` ${attached} already ${attached === 1 ? 'has a scan' : 'have scans'} attached and can be named now without returning to the bank.` : ''}`,
        impact: `${numbered} of ${checks.pendingCount} directly lookupable`,
      })
    }

    // Point at the fastest route through the backlog rather than leaving the
    // owner to work out where to start among 200 rows.
    const top = checks.topClusters[0]
    if (top && top.count >= 3) {
      const others = checks.topClusters.slice(1, 3)
      out.push({
        id: 'auto-checks-clusters',
        severity: 'opportunity',
        category: 'Expenses',
        title: 'Repeating check amounts can be resolved in one pass',
        detail: `${top.count} checks were each written for exactly ${formatCurrency(top.amount)}${top.cadence ? ` on a ${top.cadence} rhythm` : ''}, worth ${formatCurrency(top.total)} together. Identical repeating amounts almost always mean a single payee on a standing arrangement, so naming that payee once settles the whole group.${others.length > 0 ? ` The next largest groups are ${others.map((c) => `${c.count}x ${formatCurrency(c.amount)}`).join(' and ')}.` : ''} Clearing the biggest groups first moves the most dollars for the least work.`,
        impact: `${formatCurrency(top.total)} in one group`,
      })
    }
  }

  /*
   * Months with sales but no cost of goods at all. Distinct from the check
   * problem: here nothing was categorized, so the margin would read as near-100%
   * profit rather than merely being overstated.
   */
  if (checks && checks.monthsMissingCogs.length > 0) {
    const list = checks.monthsMissingCogs
    out.push({
      id: 'auto-checks-months-missing-cogs',
      severity: 'warning',
      category: 'Expenses',
      title: 'Some complete months record sales but no cost of goods',
      detail: `${list.length} complete ${list.length === 1 ? 'month has' : 'months have'} Square sales but no cost-of-goods spend recorded at all (${list.join(', ')}). The shop plainly bought stock in ${list.length === 1 ? 'that month' : 'those months'}, so this is a categorization gap rather than a month without purchases. Any margin for ${list.length === 1 ? 'it' : 'them'} would read as almost pure profit, which would flatter the average across every window.`,
      impact: `${list.length} ${list.length === 1 ? 'month' : 'months'} without COGS`,
    })
  }

  /*
   * Months whose bank statements were never imported. A DIFFERENT insight from
   * the categorization gap above, and deliberately so: telling the owner to
   * categorize cost of goods in a month that contains no bank transactions sends
   * them to do work that cannot be done. The remedy here is an import.
   */
  if (checks && (checks.monthsMissingBankData?.length ?? 0) > 0) {
    const list = checks.monthsMissingBankData ?? []
    out.push({
      id: 'auto-checks-months-missing-bank-data',
      severity: 'warning',
      category: 'Expenses',
      title: 'Some months have sales but no bank transactions imported',
      detail: `${list.length} ${list.length === 1 ? 'month has' : 'months have'} Square sales but no deposits or bank spending on file (${list.join(', ')}) — only card statements reached ${list.length === 1 ? 'it' : 'them'}. Cost of goods for ${list.length === 1 ? 'that month' : 'those months'} is therefore a fragment of what was really spent, and a margin would compute to almost pure profit. This is an import gap, not a categorization one: there are no transactions there to categorize. Importing the missing bank statements also closes the matching hole in net cash movement.`,
      impact: `${list.length} ${list.length === 1 ? 'month' : 'months'} without bank data`,
    })
  }

  if (checks && checks.pendingCount === 0 && checks.resolvedCount > 0) {
    out.push({
      id: 'auto-checks-resolved',
      severity: 'opportunity',
      category: 'Expenses',
      title: 'Every check payment now has a payee',
      detail: `All ${checks.resolvedCount} check payments have been attributed, so cost of goods now includes the money that moved by check. Gross margin can be read as a real figure rather than a floor. Keeping new checks resolved as they arrive is what holds that accuracy in place.`,
      impact: '100% of check dollars attributed',
    })
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

    // Net movement for the newest trustworthy month. Upstream this is both
    // FINISHED and deposit-bearing, so neither a card-only month (spending with
    // no deposits, reading as a total loss) nor a month that is still running
    // (a few days reading as an overspend) can reach this verdict.
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
        detail: `${formatCurrency(unidentifiedOutflow.amount)} across ${unidentifiedOutflow.count} transactions is described only as a check or generic withdrawal, so no rule can attribute it automatically. The export carries no payee, because the payee exists only on the physical check. Most of these do carry a check number, so they can be looked up in the bank portal and the scan attached on the Check Resolution screen — that is the only way to see where that money actually went.`,
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

  // --- Marketing affordability ---
  // Every figure here is passed in from the marketing service, so the Advisor
  // and the Marketing Budget page can never disagree about what is affordable.
  if (marketing) {
    const seasonNote =
      marketing.seasonalLabel && marketing.seasonalIndex != null
        ? ` ${marketing.seasonalLabel} typically runs ${formatPercent(Math.abs(marketing.seasonalIndex - 1) * 100, 0)} ${marketing.seasonalIndex >= 1 ? 'above' : 'below'} an average month.`
        : ''

    if (marketing.reserveCoverage < 0) {
      // Bills already exceed cash. Naming a spendable budget here would read as
      // permission to spend money that does not exist.
      out.push({
        id: 'auto-marketing-no-room',
        severity: 'critical',
        category: 'Marketing',
        title: 'No cash is available for marketing this month',
        // `summary` normally already ends with the first blocker, so blockers
        // are filtered against it rather than blindly appended — otherwise the
        // same sentence prints twice on the Advisor page.
        detail: [
          marketing.summary,
          ...marketing.blockers.filter((b) => !marketing.summary.includes(b)),
          'Cut marketing back to what is already committed until the reserve is rebuilt, rather than adding spend.',
        ]
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
        impact: `Marketing capacity ${marketing.band}`,
      })
    } else if (marketing.action === 'reduce') {
      out.push({
        id: 'auto-marketing-reduce',
        severity: 'warning',
        category: 'Marketing',
        title: 'Marketing is running above what cash supports',
        detail: `${formatCurrency(marketing.current)} a month is going out, but only ${formatCurrency(marketing.recommended)} is supportable after the reserve, bills and payroll are covered.${seasonNote} ${marketing.blockers.join(' ')}`.trim(),
        impact: `Reduce by ${formatCurrency(Math.max(0, marketing.current - marketing.recommended))}/mo`,
      })
    } else if (marketing.action === 'increase') {
      out.push({
        id: 'auto-marketing-headroom',
        severity: 'opportunity',
        category: 'Marketing',
        title: `Room to raise marketing to ${formatCurrency(marketing.recommended)} a month`,
        detail: `Cash covers the reserve, bills and payroll with ${formatCurrency(marketing.additionalSafe)} to spare, so marketing can rise from ${formatCurrency(marketing.current)} to ${formatCurrency(marketing.recommended)}.${seasonNote} Based on ${marketing.confidenceLabel.toLowerCase()} confidence data.`,
        impact: `Up to ${formatCurrency(marketing.recommended - marketing.current)}/mo more`,
      })
    }

    // Channels that went quiet distort the baseline more than miscategorization
    // does, because the trailing average scores them as zero rather than merely
    // misfiling them. Raised first for that reason.
    if (marketing.lapsedChannels.length > 0) {
      const worst = marketing.lapsedChannels[0]
      out.push({
        id: 'auto-marketing-lapsed',
        severity: 'warning',
        category: 'Marketing',
        title: `${marketing.lapsedChannels.length === 1 ? worst.channel : `${marketing.lapsedChannels.length} marketing channels`} stopped appearing in the bank feed`,
        // Deliberately NOT a sum of the per-channel rates. Those averages cover
        // different, non-overlapping periods (one channel was two charges in a
        // single season), so adding them implies a concurrent monthly total that
        // was never actually paid — it overstated real spend by roughly 2x.
        detail: `${marketing.lapsedChannels
          .map(
            (l) =>
              `${l.channel} last billed ${l.lastDate} (${l.monthsSinceLastCharge} months ago, averaging ${formatCurrency(l.typicalMonthly)} in the months it did bill)`,
          )
          .join(
            '; ',
          )}. If you are still paying any of these, the money is leaving by a route the bank export cannot attribute — usually a check — so it is missing from the ${formatCurrency(marketing.categorizedMonthly)}/mo the bank feed shows. ${
          // Naming the obligation the owner already recorded is the difference
          // between "the app thinks I spend $16" and "the bank can only see $16
          // of my $800". Without it this insight implies the $16 is the budget.
          marketing.commitmentMismatch
            ? `That is measured spend, not your budget: you have ${formatCurrency(marketing.commitmentMismatch.committed)}/mo of marketing obligations on file, and the recommendation below is built on that figure, not on ${formatCurrency(marketing.categorizedMonthly)}.`
            : `That figure is only what the bank feed can see, so it is not a budget. Record what you actually pay each month as a marketing obligation on the Cash Obligations page and the recommendation below will use it instead.`
        } How much is missing cannot be measured from this data: those averages cover different periods and must not be added together. Confirm which channels are still running before trusting this recommendation.`,
        impact: 'Marketing baseline understated',
      })
    }

    // Reported spend that is far below reality makes every figure above suspect,
    // so this is raised regardless of the recommendation.
    if (marketing.uncategorized) {
      out.push({
        id: 'auto-marketing-uncategorized',
        severity: 'warning',
        category: 'Marketing',
        title: `${formatCurrency(marketing.uncategorized.impliedMonthly)}/mo of advertising is not categorized as marketing`,
        detail: `${formatCurrency(marketing.uncategorized.total)} of charges that look like advertising (${marketing.uncategorized.topChannels.join(', ')}) are filed under a blank category, so the ${formatCurrency(marketing.categorizedMonthly)}/mo of marketing the bank feed can see is understated${marketing.commitmentMismatch ? ` against the ${formatCurrency(marketing.commitmentMismatch.committed)}/mo you have on file` : ''}. Set their category to Marketing on the Transactions page — until then, treat the marketing budget above as provisional.`,
        impact: 'Understates marketing spend',
      })
    }

    // A committed budget that is not actually being spent is either a saving
    // already banked, or marketing hiding in the uncategorized pile. Either way
    // the owner should know the two numbers disagree.
    if (marketing.commitmentMismatch) {
      out.push({
        id: 'auto-marketing-commitment-gap',
        severity: 'warning',
        category: 'Marketing',
        title: 'Committed marketing does not match actual spend',
        detail: marketing.commitmentMismatch.note,
        impact: `${formatCurrency(Math.abs(marketing.commitmentMismatch.committed - marketing.commitmentMismatch.actual))}/mo difference`,
      })
    }
  }

  // --- Bill pay / outstanding checks ---
  // Only speaks when checks are actually outstanding, so a farm with none gets
  // no noise. Two distinct concerns: (1) outstanding checks push spendable cash
  // below the reserve even though the bank balance looks fine, and (2) a check
  // that has sat uncleared for weeks may be lost and worth reissuing.
  if (billPay && billPay.outstandingCheckCount > 0) {
    // The dangerous case: the bank balance clears the reserve, but once the
    // written checks land, spendable cash does not. This is exactly the gap the
    // bank balance hides.
    if (billPay.cashAvailable < billPay.minCashReserve) {
      out.push({
        id: 'auto-billpay-reserve-breach',
        severity: 'warning',
        category: 'Cash',
        title: 'Outstanding checks pull spendable cash below your reserve',
        detail: `${billPay.outstandingCheckCount} written ${
          billPay.outstandingCheckCount === 1 ? 'check has' : 'checks have'
        } not cleared yet. Once they do, spendable cash drops to ${formatCurrency(
          billPay.cashAvailable,
        )} — below your ${formatCurrency(
          billPay.minCashReserve,
        )} reserve. Hold non-essential spending until they clear.`,
        impact: `${formatCurrency(billPay.outstandingChecks)} committed but not yet withdrawn`,
      })
    } else {
      out.push({
        id: 'auto-billpay-outstanding',
        severity: 'opportunity',
        category: 'Cash',
        title: 'Written checks are still outstanding',
        detail: `${billPay.outstandingCheckCount} ${
          billPay.outstandingCheckCount === 1 ? 'check' : 'checks'
        } totaling ${formatCurrency(
          billPay.outstandingChecks,
        )} have not cleared the bank. Your spendable cash is ${formatCurrency(
          billPay.cashAvailable,
        )}, not the full bank balance.`,
        impact: `${formatCurrency(billPay.outstandingChecks)} committed but not yet withdrawn`,
      })
    }

    // A check uncleared for a month is worth chasing — it may be lost.
    if (billPay.oldestOutstandingDays != null && billPay.oldestOutstandingDays >= 30) {
      out.push({
        id: 'auto-billpay-stale-check',
        severity: 'warning',
        category: 'Cash',
        title: 'A written check has been uncleared for weeks',
        detail: `The oldest outstanding check was written ${billPay.oldestOutstandingDays} days ago and still has not cleared. Confirm the payee received it before it is stale-dated, and reissue if it was lost.`,
        impact: `Uncleared ${billPay.oldestOutstandingDays} days`,
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
