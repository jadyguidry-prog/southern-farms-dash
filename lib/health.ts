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

type InsightInput = {
  settings: BusinessSettings
  pillars: HealthPillars
  /** Obligations still missing a due date, so scheduling can't be projected. */
  obligationsMissingDueDate?: { name: string; amount: number }[]
  overdueObligations?: number
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
      detail: `${payroll.message} Labor efficiency is working in your favor this period.`,
      impact: `Target ${formatPercent(settings.target_payroll_pct, 0)} of sales`,
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
