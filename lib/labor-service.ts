/**
 * Labor cost derived from Square timecards (`square_shifts`).
 *
 * This module deliberately never claims to know payroll. Square stores the wage
 * that was attached to each timecard, so what can be derived honestly is an
 * *estimate* of gross labor: payable hours times the rate on the shift. It does
 * not know taxes, employer burden, salaries, bonuses, or cash paid outside the
 * clock. Every exported name says "estimated" for that reason, and the UI is
 * expected to repeat it.
 *
 * Four failure modes are handled explicitly, because each would silently
 * understate or overstate cost:
 *
 * 1. **Missing wage rates.** 22 timecards carry a rate of 0 (the owner's own
 *    shifts). Multiplying those by zero would quietly book free labor, so they
 *    are excluded from the cost total and surfaced separately as Unpriced Labor,
 *    with their hours still counted in the hour totals.
 * 2. **Unpaid breaks.** On-clock time is not payable time. Payable hours
 *    subtract unpaid break minutes; both figures are reported so the difference
 *    is visible rather than assumed.
 * 3. **Local time.** A shift starting 01:00 UTC belongs to the previous evening
 *    in America/Chicago. Bucketing on the UTC date would move hours into the
 *    wrong month, so every shift is bucketed on its own timezone's local date.
 * 4. **Partial sales coverage.** Labor % is only as good as the sales it is
 *    divided by. Months whose calendar span is not fully inside the Square sales
 *    feed are marked partial and are never scored — this is what stops the
 *    2024-07 ratio (3 days of sales against a full month of labor, which reads
 *    as 129%) from being presented as a real result.
 */
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { monthLabel } from '@/lib/cash-flow-service'
import {
  getSquareDailySales,
  type SquareDailyRow,
} from '@/lib/square-sales-service'

export { monthLabel }

/**
 * The federal FLSA overtime line: hours beyond 40 in a workweek are paid at
 * 1.5x. This is statute rather than a business preference, which is why it is a
 * constant here instead of an owner-configurable target.
 */
export const OVERTIME_WEEKLY_THRESHOLD_HOURS = 40
export const OVERTIME_MULTIPLIER = 1.5

/**
 * Review thresholds for timecard hygiene, not financial targets.
 *
 * Square auto-closes a forgotten timecard at exactly 24 hours, so a 24.00-hour
 * shift is almost always a missed clock-out rather than a day of work. Those
 * shifts inflate both hours and cost, so they are flagged for review instead of
 * being silently trusted or silently dropped.
 */
export const LONG_SHIFT_REVIEW_HOURS = 14
export const MISSED_CLOCKOUT_HOURS = 24

/** Fallback only for rows Square stored without a timezone. */
const DEFAULT_TIMEZONE = 'America/Chicago'

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

/** A raw `square_shifts` row, loosely typed so callers can pass DB output. */
export type LaborShiftInput = {
  square_shift_id?: unknown
  square_team_member_id?: unknown
  square_location_id?: unknown
  start_at?: unknown
  end_at?: unknown
  timezone?: unknown
  job_title?: unknown
  hourly_rate?: unknown
  unpaid_break_minutes?: unknown
  paid_break_minutes?: unknown
  status?: unknown
  is_deleted?: unknown
}

export type LaborShift = {
  shiftId: string
  teamMemberId: string
  employeeName: string
  locationId: string
  jobTitle: string
  /** Local calendar date the shift started, `YYYY-MM-DD`. */
  localDate: string
  /** `YYYY-MM` of `localDate`. */
  monthKey: string
  /** Local Sunday that starts the FLSA workweek, `YYYY-MM-DD`. */
  weekKey: string
  onClockHours: number
  unpaidBreakHours: number
  paidBreakHours: number
  /** On-clock minus unpaid breaks — the hours a wage actually applies to. */
  payableHours: number
  /** Null when Square carried no usable wage for the shift. */
  hourlyRate: number | null
  /** False when the rate is missing or zero; such shifts carry no cost. */
  priced: boolean
  /** payableHours x hourlyRate, or 0 when unpriced. Never a guess. */
  estimatedCost: number
  longShift: boolean
  likelyMissedClockOut: boolean
}

/** Shifts Square has not closed yet, reported rather than silently dropped. */
export type LaborExclusions = {
  openShifts: number
  deletedShifts: number
  invalidShifts: number
}

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Local `YYYY-MM-DD` for an instant in a timezone.
 *
 * Formatters are cached because building one per row is measurably slow across
 * thousands of timecards.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>()
export function localDateIn(iso: string, timeZone: string): string {
  let fmt = formatterCache.get(timeZone)
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    } catch {
      // An unknown timezone must not throw away the shift.
      fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: DEFAULT_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    }
    formatterCache.set(timeZone, fmt)
  }
  // en-CA yields ISO-ordered YYYY-MM-DD.
  return fmt.format(new Date(iso))
}

/** The Sunday that begins the workweek containing `localDate`. */
export function weekStartOf(localDate: string): string {
  const d = new Date(`${localDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d.toISOString().slice(0, 10)
}

/**
 * Turn raw timecards into normalized shifts.
 *
 * Deleted timecards and shifts Square has not closed are excluded from the
 * results and counted in `exclusions`, so an in-progress shift cannot be costed
 * with an imaginary end time.
 */
export function normalizeShifts(
  rows: LaborShiftInput[],
  employeeNames: Map<string, string> = new Map(),
): { shifts: LaborShift[]; exclusions: LaborExclusions } {
  const shifts: LaborShift[] = []
  const exclusions: LaborExclusions = {
    openShifts: 0,
    deletedShifts: 0,
    invalidShifts: 0,
  }

  for (const r of rows) {
    if (r.is_deleted === true) {
      exclusions.deletedShifts += 1
      continue
    }

    const startAt = str(r.start_at)
    const endAt = str(r.end_at)
    if (!startAt) {
      exclusions.invalidShifts += 1
      continue
    }
    if (!endAt) {
      exclusions.openShifts += 1
      continue
    }

    const startMs = new Date(startAt).getTime()
    const endMs = new Date(endAt).getTime()
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      exclusions.invalidShifts += 1
      continue
    }

    const onClockHours = (endMs - startMs) / 3_600_000
    const unpaidBreakHours = num(r.unpaid_break_minutes) / 60
    const paidBreakHours = num(r.paid_break_minutes) / 60
    // Guard against a break longer than the shift, which would invert the sign.
    const payableHours = Math.max(0, onClockHours - unpaidBreakHours)

    const timezone = str(r.timezone) || DEFAULT_TIMEZONE
    const localDate = localDateIn(startAt, timezone)

    const rawRate = r.hourly_rate == null ? null : num(r.hourly_rate)
    // A stored 0 means Square had no wage for this timecard. Treating it as a
    // real $0 rate would book the hours as free labor.
    const priced = rawRate != null && rawRate > 0
    const teamMemberId = str(r.square_team_member_id)

    shifts.push({
      shiftId: str(r.square_shift_id),
      teamMemberId,
      employeeName: employeeNames.get(teamMemberId) || teamMemberId || 'Unknown',
      locationId: str(r.square_location_id),
      // Square titles arrive with stray whitespace ("Butcher Apprentice "),
      // which would otherwise split one job into two rows in every breakdown.
      jobTitle: str(r.job_title).trim(),
      localDate,
      monthKey: localDate.slice(0, 7),
      weekKey: weekStartOf(localDate),
      onClockHours,
      unpaidBreakHours,
      paidBreakHours,
      payableHours,
      hourlyRate: priced ? rawRate : null,
      priced,
      estimatedCost: priced ? payableHours * (rawRate as number) : 0,
      longShift: onClockHours >= LONG_SHIFT_REVIEW_HOURS,
      likelyMissedClockOut: onClockHours >= MISSED_CLOCKOUT_HOURS,
    })
  }

  shifts.sort((a, b) => a.localDate.localeCompare(b.localDate))
  return { shifts, exclusions }
}

/* ------------------------------------------------------------------ */
/* Overtime                                                            */
/* ------------------------------------------------------------------ */

export type OvertimeAllocation = {
  shiftId: string
  overtimeHours: number
  /** The 0.5x premium only — base pay is already in `estimatedCost`. */
  premiumCost: number
}

export type OvertimeResult = {
  totalOvertimeHours: number
  /** Estimated premium above base pay. */
  totalPremiumCost: number
  /** Employee-weeks that crossed the threshold. */
  overtimeWeeks: number
  byShift: Map<string, OvertimeAllocation>
}

/**
 * Allocate overtime per employee per workweek.
 *
 * Overtime is a property of a *week*, not a shift, so hours are accumulated
 * chronologically within each employee-week and the hours past the threshold are
 * attributed to the later shifts that actually crossed it. That keeps the
 * premium on the correct month and the correct wage rate when a week spans a
 * month boundary or the employee's rate changed mid-week.
 *
 * Only the 0.5x premium is counted, because the base hour is already included
 * in estimated gross labor. Adding a full 1.5x would double-count it.
 */
export function computeOvertime(shifts: LaborShift[]): OvertimeResult {
  const byWeek = new Map<string, LaborShift[]>()
  for (const s of shifts) {
    const key = `${s.teamMemberId}|${s.weekKey}`
    const list = byWeek.get(key)
    if (list) list.push(s)
    else byWeek.set(key, [s])
  }

  const byShift = new Map<string, OvertimeAllocation>()
  let totalOvertimeHours = 0
  let totalPremiumCost = 0
  let overtimeWeeks = 0

  for (const week of byWeek.values()) {
    const total = week.reduce((sum, s) => sum + s.payableHours, 0)
    if (total <= OVERTIME_WEEKLY_THRESHOLD_HOURS) continue
    overtimeWeeks += 1

    const ordered = [...week].sort((a, b) => a.localDate.localeCompare(b.localDate))
    let cumulative = 0
    for (const s of ordered) {
      const before = cumulative
      cumulative += s.payableHours
      // The portion of this shift sitting above the weekly threshold: the
      // overlap between [before, cumulative] and everything past 40 hours.
      const above =
        Math.max(0, cumulative - OVERTIME_WEEKLY_THRESHOLD_HOURS) -
        Math.max(0, before - OVERTIME_WEEKLY_THRESHOLD_HOURS)
      if (above <= 0) continue

      // Unpriced shifts contribute overtime hours but no cost, matching how
      // they are handled everywhere else.
      const premiumCost = s.priced
        ? above * (s.hourlyRate as number) * (OVERTIME_MULTIPLIER - 1)
        : 0

      byShift.set(s.shiftId, {
        shiftId: s.shiftId,
        overtimeHours: above,
        premiumCost,
      })
      totalOvertimeHours += above
      totalPremiumCost += premiumCost
    }
  }

  return {
    totalOvertimeHours: round2(totalOvertimeHours),
    totalPremiumCost: round2(totalPremiumCost),
    overtimeWeeks,
    byShift,
  }
}

/* ------------------------------------------------------------------ */
/* Sales coverage                                                      */
/* ------------------------------------------------------------------ */

export type MonthCoverage = 'complete' | 'partial' | 'none'

export type SalesCoverage = {
  /** First and last day the Square sales feed has any data for. */
  firstDate: string | null
  lastDate: string | null
  netByMonth: Map<string, number>
  daysByMonth: Map<string, number>
}

/** Last calendar day of a `YYYY-MM`, as `YYYY-MM-DD`. */
export function monthEnd(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4))
  const month = Number(monthKey.slice(5, 7))
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${monthKey}-${String(last).padStart(2, '0')}`
}

/**
 * Reduce resolved Square daily rows to monthly net sales plus the feed's own
 * date boundaries.
 */
export function deriveSalesCoverage(
  rows: Pick<SquareDailyRow, 'saleDate' | 'netSales'>[],
): SalesCoverage {
  const netByMonth = new Map<string, number>()
  const daysByMonth = new Map<string, number>()
  let firstDate: string | null = null
  let lastDate: string | null = null

  for (const r of rows) {
    const date = r.saleDate
    if (!date) continue
    if (firstDate === null || date < firstDate) firstDate = date
    if (lastDate === null || date > lastDate) lastDate = date
    const key = date.slice(0, 7)
    netByMonth.set(key, (netByMonth.get(key) ?? 0) + r.netSales)
    daysByMonth.set(key, (daysByMonth.get(key) ?? 0) + 1)
  }

  return { firstDate, lastDate, netByMonth, daysByMonth }
}

/**
 * Whether a month's sales can be compared against a full month of labor.
 *
 * The test is calendar containment inside the feed's range, not a day count:
 * the shop closes on Sundays, so 26 sales days in a 31-day month is normal and
 * complete. What is *not* comparable is a month the feed only partly covers —
 * July 2024 begins 28 days before the feed does, and the current month has not
 * finished yet.
 */
export function monthSalesCoverage(
  monthKey: string,
  coverage: SalesCoverage,
): MonthCoverage {
  const { firstDate, lastDate } = coverage
  if (!firstDate || !lastDate) return 'none'

  const start = `${monthKey}-01`
  const end = monthEnd(monthKey)

  // No overlap at all: the month sits entirely outside the sales feed.
  if (end < firstDate || start > lastDate) return 'none'
  // Fully inside the feed on both edges.
  if (start >= firstDate && end <= lastDate) return 'complete'
  return 'partial'
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

export type LaborFilters = {
  /** Inclusive local-date bounds, `YYYY-MM-DD`. */
  from?: string
  to?: string
  employeeId?: string
  jobTitle?: string
  locationId?: string
}

export function filterShifts(
  shifts: LaborShift[],
  filters: LaborFilters = {},
): LaborShift[] {
  const { from, to, employeeId, jobTitle, locationId } = filters
  return shifts.filter((s) => {
    if (from && s.localDate < from) return false
    if (to && s.localDate > to) return false
    if (employeeId && s.teamMemberId !== employeeId) return false
    if (jobTitle && s.jobTitle !== jobTitle) return false
    if (locationId && s.locationId !== locationId) return false
    return true
  })
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

export type UnpricedGroup = {
  label: string
  shifts: number
  hours: number
}

export type LaborSummary = {
  shiftCount: number
  onClockHours: number
  unpaidBreakHours: number
  payableHours: number
  /** Payable hours x rate, excluding every shift with no rate. */
  estimatedGrossLabor: number
  activeEmployees: number
  /** Square net sales over the same months, null when the feed has none. */
  netSales: number | null
  /** Estimated gross labor as a share of net sales, null without sales. */
  laborPct: number | null
  /** Net sales per payable labor hour, null without sales or hours. */
  salesPerLaborHour: number | null
  overtimeHours: number
  estimatedOvertimeCost: number
  overtimeWeeks: number
  unpricedShifts: number
  unpricedHours: number
  /** Who the unpriced hours belong to, so they can be fixed in Square. */
  unpricedBy: UnpricedGroup[]
  longShifts: number
  likelyMissedClockOuts: number
  firstDate: string | null
  lastDate: string | null
  /** Months in range whose sales coverage is incomplete. */
  partialMonths: string[]
  monthsWithoutSales: string[]
  /**
   * True when every month in range has complete sales coverage. Ratios should
   * be hidden or labelled when this is false.
   */
  salesComparable: boolean
}

/**
 * Aggregate shifts into headline labor figures.
 *
 * Sales are taken from whole months, because Square daily sales and labor months
 * are the only granularity that line up reliably. A month with incomplete sales
 * coverage is left out of the sales side entirely rather than dividing a full
 * month of labor by a few days of revenue.
 */
export function summarizeLabor(
  shifts: LaborShift[],
  coverage: SalesCoverage,
): LaborSummary {
  const overtime = computeOvertime(shifts)

  let onClockHours = 0
  let unpaidBreakHours = 0
  let payableHours = 0
  let estimatedGrossLabor = 0
  let unpricedShifts = 0
  let unpricedHours = 0
  let longShifts = 0
  let likelyMissedClockOuts = 0
  const employees = new Set<string>()
  const months = new Set<string>()
  const unpricedByLabel = new Map<string, UnpricedGroup>()
  let firstDate: string | null = null
  let lastDate: string | null = null

  for (const s of shifts) {
    onClockHours += s.onClockHours
    unpaidBreakHours += s.unpaidBreakHours
    payableHours += s.payableHours
    estimatedGrossLabor += s.estimatedCost
    employees.add(s.teamMemberId)
    months.add(s.monthKey)
    if (s.longShift) longShifts += 1
    if (s.likelyMissedClockOut) likelyMissedClockOuts += 1
    if (firstDate === null || s.localDate < firstDate) firstDate = s.localDate
    if (lastDate === null || s.localDate > lastDate) lastDate = s.localDate

    if (!s.priced) {
      unpricedShifts += 1
      unpricedHours += s.payableHours
      const label = s.jobTitle
        ? `${s.employeeName} — ${s.jobTitle}`
        : s.employeeName
      const group = unpricedByLabel.get(label)
      if (group) {
        group.shifts += 1
        group.hours += s.payableHours
      } else {
        unpricedByLabel.set(label, {
          label,
          shifts: 1,
          hours: s.payableHours,
        })
      }
    }
  }

  // Sales are only added for months that fully line up with the feed.
  const partialMonths: string[] = []
  const monthsWithoutSales: string[] = []
  let netSales = 0
  let comparableMonths = 0

  for (const monthKey of [...months].sort()) {
    const status = monthSalesCoverage(monthKey, coverage)
    if (status === 'complete') {
      netSales += coverage.netByMonth.get(monthKey) ?? 0
      comparableMonths += 1
    } else if (status === 'partial') {
      partialMonths.push(monthKey)
    } else {
      monthsWithoutSales.push(monthKey)
    }
  }

  const hasSales = comparableMonths > 0
  // Labor for the comparable months only, so the ratio has matching numerator
  // and denominator rather than all labor over some of the sales.
  let comparableLabor = 0
  let comparableHours = 0
  for (const s of shifts) {
    if (monthSalesCoverage(s.monthKey, coverage) !== 'complete') continue
    comparableLabor += s.estimatedCost
    comparableHours += s.payableHours
  }

  return {
    shiftCount: shifts.length,
    onClockHours: round2(onClockHours),
    unpaidBreakHours: round2(unpaidBreakHours),
    payableHours: round2(payableHours),
    estimatedGrossLabor: round2(estimatedGrossLabor),
    activeEmployees: employees.size,
    netSales: hasSales ? round2(netSales) : null,
    laborPct:
      hasSales && netSales > 0 ? round2((comparableLabor / netSales) * 100) : null,
    salesPerLaborHour:
      hasSales && comparableHours > 0 ? round2(netSales / comparableHours) : null,
    overtimeHours: overtime.totalOvertimeHours,
    estimatedOvertimeCost: overtime.totalPremiumCost,
    overtimeWeeks: overtime.overtimeWeeks,
    unpricedShifts,
    unpricedHours: round2(unpricedHours),
    unpricedBy: [...unpricedByLabel.values()]
      .map((g) => ({ ...g, hours: round2(g.hours) }))
      .sort((a, b) => b.hours - a.hours),
    longShifts,
    likelyMissedClockOuts,
    firstDate,
    lastDate,
    partialMonths,
    monthsWithoutSales,
    salesComparable:
      hasSales && partialMonths.length === 0 && monthsWithoutSales.length === 0,
  }
}

/* ------------------------------------------------------------------ */
/* Monthly trend                                                       */
/* ------------------------------------------------------------------ */

export type LaborMonth = {
  monthKey: string
  /** `Jun '26` — keeps the year visible so two years cannot interleave. */
  month: string
  payableHours: number
  onClockHours: number
  estimatedGrossLabor: number
  /** Null unless the month's sales coverage is complete. */
  netSales: number | null
  laborPct: number | null
  salesPerLaborHour: number | null
  overtimeHours: number
  estimatedOvertimeCost: number
  shiftCount: number
  employees: number
  unpricedShifts: number
  unpricedHours: number
  coverage: MonthCoverage
  /** True when the ratios for this month must not be compared or scored. */
  partial: boolean
}

/**
 * Monthly labor series, oldest first, keyed on real `YYYY-MM`.
 *
 * Sorting on the month key rather than a month name is what keeps Dec '25 from
 * sorting next to Jan '25 — the interleaving bug already fixed elsewhere in this
 * codebase.
 */
export function deriveMonthlyLabor(
  shifts: LaborShift[],
  coverage: SalesCoverage,
): LaborMonth[] {
  const overtime = computeOvertime(shifts)
  const buckets = new Map<
    string,
    {
      payableHours: number
      onClockHours: number
      cost: number
      overtimeHours: number
      overtimeCost: number
      shiftCount: number
      employees: Set<string>
      unpricedShifts: number
      unpricedHours: number
    }
  >()

  for (const s of shifts) {
    let b = buckets.get(s.monthKey)
    if (!b) {
      b = {
        payableHours: 0,
        onClockHours: 0,
        cost: 0,
        overtimeHours: 0,
        overtimeCost: 0,
        shiftCount: 0,
        employees: new Set(),
        unpricedShifts: 0,
        unpricedHours: 0,
      }
      buckets.set(s.monthKey, b)
    }
    b.payableHours += s.payableHours
    b.onClockHours += s.onClockHours
    b.cost += s.estimatedCost
    b.shiftCount += 1
    b.employees.add(s.teamMemberId)
    if (!s.priced) {
      b.unpricedShifts += 1
      b.unpricedHours += s.payableHours
    }
    const ot = overtime.byShift.get(s.shiftId)
    if (ot) {
      b.overtimeHours += ot.overtimeHours
      b.overtimeCost += ot.premiumCost
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthKey, b]) => {
      const status = monthSalesCoverage(monthKey, coverage)
      // Only a fully covered month gets a sales figure. Handing a partial month
      // its 3 days of revenue is what produced the 129% July 2024 ratio.
      const netSales =
        status === 'complete' ? round2(coverage.netByMonth.get(monthKey) ?? 0) : null

      return {
        monthKey,
        month: monthLabel(monthKey),
        payableHours: round2(b.payableHours),
        onClockHours: round2(b.onClockHours),
        estimatedGrossLabor: round2(b.cost),
        netSales,
        laborPct:
          netSales != null && netSales > 0 ? round2((b.cost / netSales) * 100) : null,
        salesPerLaborHour:
          netSales != null && b.payableHours > 0
            ? round2(netSales / b.payableHours)
            : null,
        overtimeHours: round2(b.overtimeHours),
        estimatedOvertimeCost: round2(b.overtimeCost),
        shiftCount: b.shiftCount,
        employees: b.employees.size,
        unpricedShifts: b.unpricedShifts,
        unpricedHours: round2(b.unpricedHours),
        coverage: status,
        partial: status !== 'complete',
      }
    })
}

/**
 * The newest month that is safe to headline: labor present and sales coverage
 * complete. Used by the dashboard so an in-progress month is never presented as
 * a finished result.
 */
export function latestCompleteLaborMonth(series: LaborMonth[]): LaborMonth | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (!series[i].partial) return series[i]
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Breakdowns                                                          */
/* ------------------------------------------------------------------ */

export type LaborGroup = {
  key: string
  label: string
  payableHours: number
  estimatedGrossLabor: number
  shiftCount: number
  overtimeHours: number
  estimatedOvertimeCost: number
  unpricedShifts: number
  unpricedHours: number
  /** Blended rate across priced hours only, null when nothing is priced. */
  averageRate: number | null
  /** Share of the group total's estimated gross labor, 0-1. */
  share: number
}

export type LaborGroupBy = 'employee' | 'jobTitle' | 'location'

/**
 * Roll shifts up by employee, job title, or location, highest cost first.
 *
 * Unpriced hours are reported per group rather than folded into the cost, so a
 * group can honestly show hours worked with no dollar figure attached.
 */
export function groupLabor(
  shifts: LaborShift[],
  by: LaborGroupBy,
): LaborGroup[] {
  const overtime = computeOvertime(shifts)
  const buckets = new Map<
    string,
    Omit<LaborGroup, 'averageRate' | 'share'> & { pricedHours: number }
  >()

  for (const s of shifts) {
    const key =
      by === 'employee'
        ? s.teamMemberId
        : by === 'jobTitle'
          ? s.jobTitle || '(no job title)'
          : s.locationId || '(no location)'
    const label =
      by === 'employee'
        ? s.employeeName
        : by === 'jobTitle'
          ? s.jobTitle || 'No job title'
          : s.locationId || 'No location'

    let b = buckets.get(key)
    if (!b) {
      b = {
        key,
        label,
        payableHours: 0,
        estimatedGrossLabor: 0,
        shiftCount: 0,
        overtimeHours: 0,
        estimatedOvertimeCost: 0,
        unpricedShifts: 0,
        unpricedHours: 0,
        pricedHours: 0,
      }
      buckets.set(key, b)
    }
    b.payableHours += s.payableHours
    b.estimatedGrossLabor += s.estimatedCost
    b.shiftCount += 1
    if (s.priced) b.pricedHours += s.payableHours
    else {
      b.unpricedShifts += 1
      b.unpricedHours += s.payableHours
    }
    const ot = overtime.byShift.get(s.shiftId)
    if (ot) {
      b.overtimeHours += ot.overtimeHours
      b.estimatedOvertimeCost += ot.premiumCost
    }
  }

  const total = [...buckets.values()].reduce(
    (sum, b) => sum + b.estimatedGrossLabor,
    0,
  )

  return [...buckets.values()]
    .map((b) => ({
      key: b.key,
      label: b.label,
      payableHours: round2(b.payableHours),
      estimatedGrossLabor: round2(b.estimatedGrossLabor),
      shiftCount: b.shiftCount,
      overtimeHours: round2(b.overtimeHours),
      estimatedOvertimeCost: round2(b.estimatedOvertimeCost),
      unpricedShifts: b.unpricedShifts,
      unpricedHours: round2(b.unpricedHours),
      averageRate:
        b.pricedHours > 0 ? round2(b.estimatedGrossLabor / b.pricedHours) : null,
      share: total > 0 ? b.estimatedGrossLabor / total : 0,
    }))
    .sort(
      (a, b) =>
        b.estimatedGrossLabor - a.estimatedGrossLabor ||
        b.payableHours - a.payableHours,
    )
}

/** Individual shifts that need a human look, worst first. */
export type ShiftFlag = {
  shiftId: string
  employeeName: string
  jobTitle: string
  localDate: string
  onClockHours: number
  payableHours: number
  reason: 'missed-clock-out' | 'long-shift'
}

export function flagLongShifts(shifts: LaborShift[]): ShiftFlag[] {
  return shifts
    .filter((s) => s.longShift)
    .map((s) => ({
      shiftId: s.shiftId,
      employeeName: s.employeeName,
      jobTitle: s.jobTitle,
      localDate: s.localDate,
      onClockHours: round2(s.onClockHours),
      payableHours: round2(s.payableHours),
      reason: s.likelyMissedClockOut
        ? ('missed-clock-out' as const)
        : ('long-shift' as const),
    }))
    .sort(
      (a, b) =>
        b.onClockHours - a.onClockHours || b.localDate.localeCompare(a.localDate),
    )
}

/* ------------------------------------------------------------------ */
/* Database reads                                                      */
/* ------------------------------------------------------------------ */

export type LaborFilterOptions = {
  employees: { id: string; name: string }[]
  jobTitles: string[]
  locations: string[]
  minDate: string | null
  maxDate: string | null
}

export type LaborDataset = {
  shifts: LaborShift[]
  exclusions: LaborExclusions
  coverage: SalesCoverage
  options: LaborFilterOptions
  /** True when no timecards have been synced at all. */
  empty: boolean
}

/**
 * Load every timecard plus the sales feed needed to price it.
 *
 * Paged past PostgREST's implicit 1,000-row cap: there are already 2,803
 * timecards, so a single unpaged select would silently return a third of the
 * labor cost and look plausible while doing it.
 */
export const getLaborDataset = cache(async (): Promise<LaborDataset> => {
  const supabase = await createClient()
  const pageSize = 1000
  const raw: LaborShiftInput[] = []

  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from('square_shifts')
      .select(
        'square_shift_id, square_team_member_id, square_location_id, start_at, end_at, timezone, job_title, hourly_rate, unpaid_break_minutes, paid_break_minutes, status, is_deleted',
      )
      .order('start_at', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1)

    if (error) break
    const batch = (data ?? []) as LaborShiftInput[]
    raw.push(...batch)
    if (batch.length < pageSize) break
  }

  const { data: members } = await supabase
    .from('square_team_members')
    .select('square_team_member_id, display_name, given_name, family_name')

  const names = new Map<string, string>()
  for (const m of members ?? []) {
    const display =
      String(m.display_name ?? '').trim() ||
      `${String(m.given_name ?? '').trim()} ${String(m.family_name ?? '').trim()}`.trim()
    if (m.square_team_member_id && display) {
      names.set(String(m.square_team_member_id), display)
    }
  }

  const { shifts, exclusions } = normalizeShifts(raw, names)
  const { rows } = await getSquareDailySales()
  const coverage = deriveSalesCoverage(rows)

  const employeeMap = new Map<string, string>()
  const jobTitles = new Set<string>()
  const locations = new Set<string>()
  for (const s of shifts) {
    employeeMap.set(s.teamMemberId, s.employeeName)
    if (s.jobTitle) jobTitles.add(s.jobTitle)
    if (s.locationId) locations.add(s.locationId)
  }

  return {
    shifts,
    exclusions,
    coverage,
    options: {
      employees: [...employeeMap.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      jobTitles: [...jobTitles].sort(),
      locations: [...locations].sort(),
      minDate: shifts.length > 0 ? shifts[0].localDate : null,
      maxDate: shifts.length > 0 ? shifts[shifts.length - 1].localDate : null,
    },
    empty: shifts.length === 0,
  }
})

export type LaborHealthSnapshot = {
  /**
   * Labor as a share of net sales for the most recent month with COMPLETE
   * sales coverage — not the whole range. The dashboard compares this against
   * the owner's target, and a partial month would understate sales and invent
   * an alarming ratio.
   */
  laborPct: number | null
  /** Which month `laborPct` describes, for labelling. */
  monthKey: string | null
  monthLabel: string | null
  estimatedGrossLabor: number
  payableHours: number
  overtimeHours: number
  /** Hours priced at $0 because Square has no wage — makes laborPct a floor. */
  unpricedHours: number
  unpricedShifts: number
  /** Who the unpriced hours belong to, so the advisor can name them. */
  unpricedBy: UnpricedGroup[]
  likelyMissedClockOuts: number
  estimatedOvertimeCost: number
  /** Net sales per payable labor hour in the headline month. */
  salesPerLaborHour: number | null
  /** False when no timecards exist, so callers can show "unknown" not 0%. */
  hasData: boolean
  /** True when a target comparison is meaningful (a complete month exists). */
  comparable: boolean
}

/**
 * The labor figures the dashboard and AI Advisor need, derived from the same
 * service the Payroll page uses so all three can never disagree.
 *
 * Deliberately reports the latest complete month rather than a range-wide
 * average: the owner's target is a monthly operating ratio, and averaging a
 * two-year range would hide a bad month behind good ones.
 */
export async function getLaborHealthSnapshot(): Promise<LaborHealthSnapshot> {
  const dataset = await getLaborDataset()
  const summary = summarizeLabor(dataset.shifts, dataset.coverage)
  const series = deriveMonthlyLabor(dataset.shifts, dataset.coverage)
  const headline = latestCompleteLaborMonth(series)

  return {
    laborPct: headline?.laborPct ?? null,
    monthKey: headline?.monthKey ?? null,
    monthLabel: headline?.month ?? null,
    estimatedGrossLabor: summary.estimatedGrossLabor,
    payableHours: summary.payableHours,
    overtimeHours: summary.overtimeHours,
    unpricedHours: summary.unpricedHours,
    unpricedShifts: summary.unpricedShifts,
    unpricedBy: summary.unpricedBy,
    likelyMissedClockOuts: summary.likelyMissedClockOuts,
    estimatedOvertimeCost: summary.estimatedOvertimeCost,
    salesPerLaborHour: headline?.salesPerLaborHour ?? null,
    hasData: !dataset.empty,
    comparable: headline !== null,
  }
}
