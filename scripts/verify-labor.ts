/**
 * Verification for lib/labor-service.ts — npx tsx scripts/verify-labor.ts
 *
 * The failures that matter here are the ones that look plausible on screen:
 * a $0 wage booked as free labor, unpaid breaks paid for, a shift bucketed into
 * the wrong month because UTC and Chicago disagree, overtime counted at 1.5x on
 * top of base pay it already included, and a partial month's three days of sales
 * dividing a full month of labor into a 129% ratio. Each has a test.
 */

import {
  normalizeShifts,
  computeOvertime,
  deriveSalesCoverage,
  monthSalesCoverage,
  monthEnd,
  weekStartOf,
  localDateIn,
  summarizeLabor,
  deriveMonthlyLabor,
  latestCompleteLaborMonth,
  laborPctWindow,
  groupLabor,
  flagLongShifts,
  filterShifts,
  OVERTIME_WEEKLY_THRESHOLD_HOURS,
  type LaborShiftInput,
  type SalesCoverage,
} from '../lib/labor-service'
import { generateInsights, payrollHealth, type LaborInsightInput } from '../lib/health'
import { SETTING_DEFAULTS } from '../lib/queries'

let pass = 0
let fail = 0
const failures: string[] = []

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`)
  }
}

function near(actual: number, expected: number, label: string, tol = 0.01) {
  if (Math.abs(actual - expected) <= tol) pass++
  else {
    fail++
    failures.push(`${label}\n    expected: ~${expected}\n    actual:   ${actual}`)
  }
}

/**
 * For assertions against LIVE, append-only tables. `eq` against a total that grows
 * with normal business activity fails on data freshness rather than on a defect,
 * so the historical figure becomes a floor: it must never go DOWN.
 */
function atLeast(actual: number, floor: number, label: string) {
  if (actual >= floor) pass++
  else {
    fail++
    failures.push(`${label}\n    expected: >= ${floor}\n    actual:   ${actual}`)
  }
}

/** The mirror of atLeast, for counts that should only ever shrink (missing data). */
function atMost(actual: number, ceiling: number, label: string) {
  if (actual <= ceiling) pass++
  else {
    fail++
    failures.push(`${label}\n    expected: <= ${ceiling}\n    actual:   ${actual}`)
  }
}

let seq = 0
function shift(p: Partial<LaborShiftInput> & { start_at: string; end_at?: string | null }): LaborShiftInput {
  seq += 1
  return {
    square_shift_id: `s${seq}`,
    square_team_member_id: 'tm1',
    square_location_id: 'loc1',
    timezone: 'America/Chicago',
    job_title: 'Retail Associate',
    hourly_rate: 10,
    unpaid_break_minutes: 0,
    paid_break_minutes: 0,
    status: 'CLOSED',
    is_deleted: false,
    end_at: p.end_at ?? null,
    ...p,
  }
}

/* ---------------- local date bucketing ---------------- */
// 02:00 UTC on the 1st is still 21:00 on the previous evening in Chicago. This
// is the whole reason months are bucketed on local time.
eq(localDateIn('2025-06-01T02:00:00Z', 'America/Chicago'), '2025-05-31', 'local date: UTC midnight rolls back a day')
eq(localDateIn('2025-06-01T20:00:00Z', 'America/Chicago'), '2025-06-01', 'local date: afternoon stays put')
// An unusable timezone must not discard the shift.
eq(localDateIn('2025-06-01T20:00:00Z', 'Not/AZone'), '2025-06-01', 'local date: bad timezone falls back')

eq(monthEnd('2025-02'), '2025-02-28', 'month end: February')
eq(monthEnd('2024-02'), '2024-02-29', 'month end: leap February')
eq(monthEnd('2025-12'), '2025-12-31', 'month end: December')

// FLSA weeks start Sunday.
eq(weekStartOf('2026-07-30'), '2026-07-26', 'week start: Thursday to Sunday')
eq(weekStartOf('2026-07-26'), '2026-07-26', 'week start: Sunday is its own start')

/* ---------------- normalization ---------------- */
{
  const { shifts, exclusions } = normalizeShifts([
    shift({ start_at: '2026-06-01T14:00:00Z', end_at: '2026-06-01T22:00:00Z' }),
    // Unpaid break: 8 on the clock, 30 minutes unpaid, 7.5 payable.
    shift({ start_at: '2026-06-02T14:00:00Z', end_at: '2026-06-02T22:00:00Z', unpaid_break_minutes: 30 }),
    // Still clocked in — cannot be costed.
    shift({ start_at: '2026-06-03T14:00:00Z', end_at: null }),
    // Removed in Square.
    shift({ start_at: '2026-06-04T14:00:00Z', end_at: '2026-06-04T22:00:00Z', is_deleted: true }),
    // End before start: corrupt.
    shift({ start_at: '2026-06-05T22:00:00Z', end_at: '2026-06-05T14:00:00Z' }),
  ])

  eq(shifts.length, 2, 'normalize: only closed valid shifts survive')
  eq(exclusions, { openShifts: 1, deletedShifts: 1, invalidShifts: 1 }, 'normalize: exclusions counted, not hidden')
  eq(shifts[0].onClockHours, 8, 'normalize: on-clock hours')
  eq(shifts[0].payableHours, 8, 'normalize: no break means payable equals on-clock')
  eq(shifts[1].payableHours, 7.5, 'normalize: unpaid break is not payable')
  eq(shifts[1].estimatedCost, 75, 'normalize: cost uses payable hours, not on-clock')
}

/* ---------------- missing wage rates ---------------- */
{
  // A stored 0 is Square saying "no wage", not "free".
  const { shifts } = normalizeShifts([
    shift({ start_at: '2026-06-01T14:00:00Z', end_at: '2026-06-01T22:00:00Z', hourly_rate: 0, job_title: 'Owner' }),
    shift({ start_at: '2026-06-02T14:00:00Z', end_at: '2026-06-02T22:00:00Z', hourly_rate: null }),
    shift({ start_at: '2026-06-03T14:00:00Z', end_at: '2026-06-03T22:00:00Z', hourly_rate: 12 }),
  ])
  eq(shifts.map((s) => s.priced), [false, false, true], 'unpriced: zero and null are both unpriced')
  eq(shifts.map((s) => s.estimatedCost), [0, 0, 96], 'unpriced: no cost invented for a missing rate')

  const empty: SalesCoverage = { firstDate: null, lastDate: null, netByMonth: new Map(), daysByMonth: new Map() }
  const sum = summarizeLabor(shifts, empty)
  eq(sum.estimatedGrossLabor, 96, 'unpriced: excluded from estimated gross labor')
  eq(sum.unpricedShifts, 2, 'unpriced: counted')
  eq(sum.unpricedHours, 16, 'unpriced: hours still reported')
  eq(sum.payableHours, 24, 'unpriced: hours included in total hours')
  eq(sum.netSales, null, 'no sales feed: net sales is null, not zero')
  eq(sum.laborPct, null, 'no sales feed: labor % is null, not zero')
  eq(sum.salesPerLaborHour, null, 'no sales feed: sales per hour is null')
}

/* ---------------- job title whitespace ---------------- */
{
  // Square really does return "Butcher Apprentice " with a trailing space.
  const { shifts } = normalizeShifts([
    shift({ start_at: '2026-06-01T14:00:00Z', end_at: '2026-06-01T22:00:00Z', job_title: 'Butcher Apprentice ' }),
    shift({ start_at: '2026-06-02T14:00:00Z', end_at: '2026-06-02T22:00:00Z', job_title: 'Butcher Apprentice' }),
  ])
  eq(groupLabor(shifts, 'jobTitle').length, 1, 'job title: trailing whitespace does not split a job into two')
}

/* ---------------- overtime ---------------- */
{
  // Six 8-hour days = 48 payable hours in one Sunday-Saturday week.
  const { shifts } = normalizeShifts([
    shift({ start_at: '2026-07-26T14:00:00Z', end_at: '2026-07-26T22:00:00Z' }),
    shift({ start_at: '2026-07-27T14:00:00Z', end_at: '2026-07-27T22:00:00Z' }),
    shift({ start_at: '2026-07-28T14:00:00Z', end_at: '2026-07-28T22:00:00Z' }),
    shift({ start_at: '2026-07-29T14:00:00Z', end_at: '2026-07-29T22:00:00Z' }),
    shift({ start_at: '2026-07-30T14:00:00Z', end_at: '2026-07-30T22:00:00Z' }),
    shift({ start_at: '2026-07-31T14:00:00Z', end_at: '2026-07-31T22:00:00Z' }),
  ])
  const ot = computeOvertime(shifts)
  eq(ot.totalOvertimeHours, 8, 'overtime: 48 hours yields 8 over the 40-hour line')
  eq(ot.overtimeWeeks, 1, 'overtime: one employee-week crossed')
  // Premium only: 8 x $10 x 0.5. The base $80 is already in gross labor, so
  // charging 1.5x here would bill those hours twice.
  eq(ot.totalPremiumCost, 40, 'overtime: premium is 0.5x, not 1.5x')
  eq(ot.byShift.size, 1, 'overtime: attributed to the shift that crossed the line')

  // Exactly 40 is not overtime.
  const { shifts: five } = normalizeShifts([
    shift({ start_at: '2026-07-26T14:00:00Z', end_at: '2026-07-26T22:00:00Z' }),
    shift({ start_at: '2026-07-27T14:00:00Z', end_at: '2026-07-27T22:00:00Z' }),
    shift({ start_at: '2026-07-28T14:00:00Z', end_at: '2026-07-28T22:00:00Z' }),
    shift({ start_at: '2026-07-29T14:00:00Z', end_at: '2026-07-29T22:00:00Z' }),
    shift({ start_at: '2026-07-30T14:00:00Z', end_at: '2026-07-30T22:00:00Z' }),
  ])
  eq(computeOvertime(five).totalOvertimeHours, 0, 'overtime: exactly 40 hours is not overtime')
  eq(OVERTIME_WEEKLY_THRESHOLD_HOURS, 40, 'overtime: threshold is the federal 40-hour week')

  // Two employees each under 40 must not be pooled into overtime.
  const { shifts: two } = normalizeShifts([
    ...[26, 27, 28, 29, 30].map((d) =>
      shift({ start_at: `2026-07-${d}T14:00:00Z`, end_at: `2026-07-${d}T22:00:00Z`, square_team_member_id: 'a' }),
    ),
    ...[26, 27, 28, 29, 30].map((d) =>
      shift({ start_at: `2026-07-${d}T14:00:00Z`, end_at: `2026-07-${d}T22:00:00Z`, square_team_member_id: 'b' }),
    ),
  ])
  eq(computeOvertime(two).totalOvertimeHours, 0, 'overtime: hours are per employee, never pooled')

  // Unpriced overtime contributes hours but no cost.
  const { shifts: unpriced } = normalizeShifts(
    [26, 27, 28, 29, 30, 31].map((d) =>
      shift({ start_at: `2026-07-${d}T14:00:00Z`, end_at: `2026-07-${d}T22:00:00Z`, hourly_rate: 0 }),
    ),
  )
  const otUnpriced = computeOvertime(unpriced)
  eq(otUnpriced.totalOvertimeHours, 8, 'overtime: unpriced hours still count as overtime hours')
  eq(otUnpriced.totalPremiumCost, 0, 'overtime: unpriced overtime carries no invented cost')
}

/* ---------------- sales coverage ---------------- */
{
  // Mirrors production: the feed starts mid-July 2024 and ends mid-July 2026.
  const coverage = deriveSalesCoverage([
    { saleDate: '2024-07-29', netSales: 1000 },
    { saleDate: '2024-07-30', netSales: 1000 },
    { saleDate: '2024-08-05', netSales: 2000 },
    { saleDate: '2026-06-15', netSales: 3000 },
    { saleDate: '2026-07-27', netSales: 500 },
  ])
  eq(coverage.firstDate, '2024-07-29', 'coverage: feed start')
  eq(coverage.lastDate, '2026-07-27', 'coverage: feed end')

  // The headline case the owner called out: July 2024 must never be scored.
  eq(monthSalesCoverage('2024-07', coverage), 'partial', 'coverage: 2024-07 is partial, feed starts on the 29th')
  // Before the feed exists there is no coverage at all — not zero sales.
  eq(monthSalesCoverage('2024-05', coverage), 'none', 'coverage: months before the feed have none')
  eq(monthSalesCoverage('2024-06', coverage), 'none', 'coverage: 2024-06 predates the feed')
  // A closed Sunday does not make a month incomplete; only the edges matter.
  eq(monthSalesCoverage('2024-08', coverage), 'complete', 'coverage: interior month is complete despite closed days')
  eq(monthSalesCoverage('2026-06', coverage), 'complete', 'coverage: last full month is complete')
  // The current month has not finished, so it cannot be compared.
  eq(monthSalesCoverage('2026-07', coverage), 'partial', 'coverage: in-progress month is partial')
  eq(monthSalesCoverage('2026-08', coverage), 'none', 'coverage: months after the feed have none')
}

/* ---------------- the 129% guard ---------------- */
{
  const coverage = deriveSalesCoverage([
    // Three days of July, then a complete August.
    { saleDate: '2024-07-29', netSales: 2000 },
    { saleDate: '2024-07-30', netSales: 2000 },
    { saleDate: '2024-07-31', netSales: 1783 },
    { saleDate: '2024-08-01', netSales: 68237 },
    { saleDate: '2024-08-31', netSales: 0 },
  ])

  const { shifts } = normalizeShifts([
    // A full month of July labor against 3 days of July sales.
    shift({ start_at: '2024-07-10T14:00:00Z', end_at: '2024-07-10T22:00:00Z', hourly_rate: 936 }),
    shift({ start_at: '2024-08-10T14:00:00Z', end_at: '2024-08-10T22:00:00Z', hourly_rate: 100 }),
  ])

  const monthly = deriveMonthlyLabor(shifts, coverage)
  const july = monthly.find((m) => m.monthKey === '2024-07')!
  eq(july.netSales, null, 'partial month: no sales figure attached')
  eq(july.laborPct, null, 'partial month: no labor % — this is the 129% that must never render')
  eq(july.salesPerLaborHour, null, 'partial month: no sales per labor hour')
  eq(july.partial, true, 'partial month: flagged partial')
  eq(july.estimatedGrossLabor, 7488, 'partial month: labor cost is still reported honestly')

  const august = monthly.find((m) => m.monthKey === '2024-08')!
  eq(august.partial, false, 'complete month: not flagged')
  near(august.laborPct!, (800 / 68237) * 100, 'complete month: labor % computed')

  // A partial month must not be the headline month.
  eq(latestCompleteLaborMonth(monthly)!.monthKey, '2024-08', 'headline: newest complete month wins')

  // Summary ratios exclude the partial month from both sides.
  const sum = summarizeLabor(shifts, coverage)
  eq(sum.partialMonths, ['2024-07'], 'summary: partial month listed')
  eq(sum.salesComparable, false, 'summary: not comparable while a partial month is in range')
  eq(sum.netSales, 68237, 'summary: only complete-month sales counted')
  near(sum.laborPct!, (800 / 68237) * 100, 'summary: labor % uses matching months on both sides')
  eq(sum.estimatedGrossLabor, 8288, 'summary: total labor still includes the partial month')
}

/* ---------------- month ordering across a year boundary ---------------- */
{
  const coverage = deriveSalesCoverage([
    { saleDate: '2025-01-01', netSales: 100 },
    { saleDate: '2026-12-31', netSales: 100 },
  ])
  const { shifts } = normalizeShifts([
    shift({ start_at: '2026-01-05T15:00:00Z', end_at: '2026-01-05T23:00:00Z' }),
    shift({ start_at: '2025-12-05T15:00:00Z', end_at: '2025-12-05T23:00:00Z' }),
    shift({ start_at: '2025-01-05T15:00:00Z', end_at: '2025-01-05T23:00:00Z' }),
  ])
  eq(
    deriveMonthlyLabor(shifts, coverage).map((m) => m.monthKey),
    ['2025-01', '2025-12', '2026-01'],
    'ordering: sorted by real month key, so Dec 25 cannot land beside Jan 25',
  )
}

/* ---------------- comparison windows ---------------- */
// The headline is one month; these windows are the context around it. The trap
// is averaging the monthly percentages, which lets a tiny month count as much as
// a huge one. These build a series where the two answers differ sharply.
{
  // Mar: 100 labor / 200 sales = 50%. Apr: 100 / 1800 = 5.56%.
  // Mean of percentages = 27.8%. Dollar-weighted = 200/2000 = 10%.
  const coverage = deriveSalesCoverage([
    { saleDate: '2025-03-01', netSales: 100 },
    { saleDate: '2025-03-31', netSales: 100 },
    { saleDate: '2025-04-01', netSales: 900 },
    { saleDate: '2025-04-30', netSales: 900 },
  ])
  // $10/h × 10 h = $100 of labor in each month.
  const { shifts } = normalizeShifts([
    shift({ start_at: '2025-03-10T14:00:00Z', end_at: '2025-03-11T00:00:00Z' }),
    shift({ start_at: '2025-04-10T14:00:00Z', end_at: '2025-04-11T00:00:00Z' }),
  ])
  const monthly = deriveMonthlyLabor(shifts, coverage)
  const all = laborPctWindow(monthly, null)
  near(all.laborPct ?? -1, 10, 'window: dollar-weighted, not a mean of monthly percentages')
  eq(all.monthsCounted, 2, 'window: counts both complete months')
  near(all.estimatedGrossLabor, 200, 'window: labor summed across the window')
  near(all.netSales, 2000, 'window: sales summed across the window')
  eq([all.firstMonth, all.lastMonth], ["Mar '25", "Apr '25"], 'window: reports the range it used')

  // Narrower window takes the NEWEST months, not the oldest.
  const one = laborPctWindow(monthly, 1)
  eq(one.monthsCounted, 1, 'window: honors the requested length')
  near(one.laborPct ?? -1, 5.56, 'window: last 1 month is April, the newest', 0.01)

  // Asking for more months than exist must report what it actually covered
  // rather than implying a longer history.
  const wide = laborPctWindow(monthly, 12)
  eq(wide.monthsCounted, 2, 'window: cannot invent months it does not have')
}
{
  // A partial month must be skipped entirely, not counted as zero sales — its
  // labor would otherwise inflate the ratio exactly like the 129% bug.
  const coverage = deriveSalesCoverage([
    { saleDate: '2025-05-01', netSales: 500 },
    { saleDate: '2025-05-31', netSales: 500 },
    { saleDate: '2025-06-01', netSales: 10 },
  ])
  const { shifts } = normalizeShifts([
    shift({ start_at: '2025-05-10T14:00:00Z', end_at: '2025-05-11T00:00:00Z' }),
    shift({ start_at: '2025-06-10T14:00:00Z', end_at: '2025-06-11T00:00:00Z' }),
  ])
  const monthly = deriveMonthlyLabor(shifts, coverage)
  const all = laborPctWindow(monthly, null)
  eq(all.monthsCounted, 1, 'window: partial month excluded from the window')
  near(all.laborPct ?? -1, 10, 'window: partial month cannot inflate the ratio')
  near(all.estimatedGrossLabor, 100, 'window: partial labor left out of the weighted total')

  // A window of only partial months has no answer — never 0%, which would read
  // as excellent.
  const onlyPartial = laborPctWindow(
    monthly.filter((m) => m.partial),
    null,
  )
  eq(onlyPartial.laborPct, null, 'window: no complete months yields null, not 0%')
  eq(onlyPartial.monthsCounted, 0, 'window: counts nothing when all months are partial')
}
eq(laborPctWindow([], null).laborPct, null, 'window: empty series yields null')
eq(laborPctWindow([], 3).monthsCounted, 0, 'window: empty series counts nothing')

/* ---------------- trend insight ---------------- */
// The point of showing three windows is telling a trend from a one-month blip.
// These two cases must produce different advice.
{
  const base = {
    ...SETTING_DEFAULTS,
    rows: [],
  }
  const pillars = {
    payroll: payrollHealth(14, base, true),
    cash: { status: 'unknown', label: '', message: '', score: null } as const,
    sales: { status: 'unknown', label: '', message: '', score: null } as const,
  }
  const labor = {
    laborPct: 14,
    monthLabel: "Jun '26",
    estimatedGrossLabor: 1000,
    payableHours: 100,
    overtimeHours: 0,
    estimatedOvertimeCost: 0,
    unpricedHours: 0,
    unpricedShifts: 0,
    unpricedBy: [],
    likelyMissedClockOuts: 0,
    salesPerLaborHour: null,
  }

  // Recent window well above the long run: a real climb.
  const rising = generateInsights({
    settings: base,
    pillars,
    labor: { ...labor, rolling3Pct: 15, rolling3Months: 3, allTimePct: 12, allTimeMonths: 24 },
  }).map((i) => i.id)
  eq(rising.includes('auto-labor-trend-up'), true, 'trend: rising labor share is called a trend')
  eq(rising.includes('auto-labor-month-outlier'), false, 'trend: a real climb is not called an outlier')

  // Wider windows flat but the month diverges: a blip, and the opposite advice.
  const blip = generateInsights({
    settings: base,
    pillars,
    labor: { ...labor, laborPct: 18, rolling3Pct: 12.2, rolling3Months: 3, allTimePct: 12, allTimeMonths: 24 },
  }).map((i) => i.id)
  eq(blip.includes('auto-labor-month-outlier'), true, 'trend: a diverging month over a flat trend is an outlier')
  eq(blip.includes('auto-labor-trend-up'), false, 'trend: a flat wider window is not called a climb')

  // Improving.
  const falling = generateInsights({
    settings: base,
    pillars,
    labor: { ...labor, rolling3Pct: 11, rolling3Months: 3, allTimePct: 14, allTimeMonths: 24 },
  }).map((i) => i.id)
  eq(falling.includes('auto-labor-trend-down'), true, 'trend: falling labor share is recognized')

  // One complete month cannot support any trend claim at all.
  const single = generateInsights({
    settings: base,
    pillars,
    labor: { ...labor, rolling3Pct: 14, rolling3Months: 1, allTimePct: 14, allTimeMonths: 1 },
  }).map((i) => i.id)
  eq(
    single.some((i) => i.startsWith('auto-labor-trend') || i === 'auto-labor-month-outlier'),
    false,
    'trend: no trend asserted from a single month',
  )

  // Missing windows must produce no trend claim either.
  const noWindows = generateInsights({ settings: base, pillars, labor }).map((i) => i.id)
  eq(
    noWindows.some((i) => i.startsWith('auto-labor-trend') || i === 'auto-labor-month-outlier'),
    false,
    'trend: absent windows produce no trend insight',
  )
}

/* ---------------- long shifts ---------------- */
{
  const { shifts } = normalizeShifts([
    // Square auto-closes a forgotten timecard at exactly 24 hours.
    shift({ start_at: '2024-08-15T05:00:00Z', end_at: '2024-08-16T05:00:00Z' }),
    shift({ start_at: '2024-08-17T05:00:00Z', end_at: '2024-08-17T20:00:00Z' }),
    shift({ start_at: '2024-08-18T14:00:00Z', end_at: '2024-08-18T22:00:00Z' }),
  ])
  const flags = flagLongShifts(shifts)
  eq(flags.length, 2, 'long shifts: only the outliers are flagged')
  eq(flags[0].reason, 'missed-clock-out', 'long shifts: 24h reads as a missed clock-out')
  eq(flags[1].reason, 'long-shift', 'long shifts: 15h is long but plausible')
}

/* ---------------- filters ---------------- */
{
  const { shifts } = normalizeShifts([
    shift({ start_at: '2026-06-01T14:00:00Z', end_at: '2026-06-01T22:00:00Z', square_team_member_id: 'a', job_title: 'Cook' }),
    shift({ start_at: '2026-06-15T14:00:00Z', end_at: '2026-06-15T22:00:00Z', square_team_member_id: 'b', job_title: 'Helper' }),
    shift({ start_at: '2026-07-01T14:00:00Z', end_at: '2026-07-01T22:00:00Z', square_team_member_id: 'a', job_title: 'Cook', square_location_id: 'loc2' }),
  ])
  eq(filterShifts(shifts, { from: '2026-06-10', to: '2026-06-30' }).length, 1, 'filter: date range')
  eq(filterShifts(shifts, { employeeId: 'a' }).length, 2, 'filter: employee')
  eq(filterShifts(shifts, { jobTitle: 'Helper' }).length, 1, 'filter: job title')
  eq(filterShifts(shifts, { locationId: 'loc2' }).length, 1, 'filter: location')
  eq(filterShifts(shifts, {}).length, 3, 'filter: no filters returns everything')
  eq(filterShifts(shifts, { employeeId: 'a', jobTitle: 'Helper' }).length, 0, 'filter: filters combine')
}

/* ---------------- empty input ---------------- */
{
  const empty: SalesCoverage = { firstDate: null, lastDate: null, netByMonth: new Map(), daysByMonth: new Map() }
  const sum = summarizeLabor([], empty)
  eq(sum.shiftCount, 0, 'empty: no shifts')
  eq(sum.estimatedGrossLabor, 0, 'empty: zero labor')
  eq(sum.laborPct, null, 'empty: no ratio invented')
  eq(sum.salesComparable, false, 'empty: nothing comparable')
  eq(sum.firstDate, null, 'empty: no date range')
  eq(deriveMonthlyLabor([], empty), [], 'empty: no monthly rows')
  eq(latestCompleteLaborMonth([]), null, 'empty: no headline month')
  eq(groupLabor([], 'employee'), [], 'empty: no groups')
}

/* ---------------- grouping shares ---------------- */
{
  const { shifts } = normalizeShifts([
    shift({ start_at: '2026-06-01T14:00:00Z', end_at: '2026-06-01T22:00:00Z', square_team_member_id: 'a', hourly_rate: 10 }),
    shift({ start_at: '2026-06-02T14:00:00Z', end_at: '2026-06-02T22:00:00Z', square_team_member_id: 'b', hourly_rate: 30 }),
  ])
  const groups = groupLabor(shifts, 'employee')
  eq(groups.map((g) => g.estimatedGrossLabor), [240, 80], 'grouping: sorted by cost, highest first')
  eq(groups.map((g) => g.share), [0.75, 0.25], 'grouping: shares sum to 1')
  eq(groups[0].averageRate, 30, 'grouping: blended rate over priced hours')

  const { shifts: noRate } = normalizeShifts([
    shift({ start_at: '2026-06-01T14:00:00Z', end_at: '2026-06-01T22:00:00Z', hourly_rate: 0 }),
  ])
  eq(groupLabor(noRate, 'employee')[0].averageRate, null, 'grouping: no rate means no blended rate')
}

/* ---------------- reconcile against the live database ---------------- */
/*
 * The unit tests above prove the arithmetic. This step proves the arithmetic is
 * being applied to all of the data: 2,803 timecards is past PostgREST's silent
 * 1,000-row cap, and a truncated read would still produce a confident, wrong,
 * and entirely plausible labor figure.
 */
async function reconcile() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log('\nSkipping database reconciliation (no service-role credentials).')
    return
  }

  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const raw: LaborShiftInput[] = []
  for (let page = 0; ; page += 1) {
    const { data, error } = await db
      .from('square_shifts')
      .select(
        'square_shift_id, square_team_member_id, square_location_id, start_at, end_at, timezone, job_title, hourly_rate, unpaid_break_minutes, paid_break_minutes, status, is_deleted',
      )
      .order('start_at', { ascending: true })
      .range(page * 1000, page * 1000 + 999)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as LaborShiftInput[]
    raw.push(...batch)
    if (batch.length < 1000) break
  }

  const { count } = await db
    .from('square_shifts')
    .select('*', { count: 'exact', head: true })
  eq(raw.length, count, 'db: paged read returned every timecard row')

  // Resolve display names the same way the app does, so unpriced attribution
  // reads as "Jady Guidry — Owner" rather than a raw Square id.
  const { data: memberRows } = await db
    .from('square_team_members')
    .select('square_team_member_id, display_name, given_name, family_name')
  const names = new Map<string, string>()
  for (const m of memberRows ?? []) {
    const name =
      String(m.display_name ?? '').trim() ||
      [m.given_name, m.family_name].filter(Boolean).join(' ').trim()
    if (name) names.set(String(m.square_team_member_id), name)
  }

  const { shifts } = normalizeShifts(raw, names)
  const sum = summarizeLabor(shifts, { firstDate: null, lastDate: null, netByMonth: new Map(), daysByMonth: new Map() })

  // These were pinned to the exact totals on the day the script was written
  // (2,803 shifts / 17,693.45h / $203,806.22). `square_shifts` is LIVE and grows
  // every time the crew works, so those equalities began failing the moment 25 new
  // shifts synced — reporting a data-freshness fact as a code regression, which is
  // noise that trains you to ignore a red suite.
  //
  // Monotonic lower bounds instead: shifts are only ever ADDED, so the historical
  // floor must always hold. A DROP below it is the thing actually worth catching
  // (a failed sync, a bad delete, a normalizer that silently discards rows) and
  // that is still caught exactly as before.
  atLeast(shifts.length, 2803, 'db: at least the 2,803 shifts known at baseline')
  atLeast(sum.payableHours, 17693.45, 'db: at least 17,693 payable hours')
  atLeast(
    sum.estimatedGrossLabor,
    203806.22,
    'db: at least ~$203,806 estimated gross labor',
  )
  // NOT a bound: an unpriced shift means a missing wage, so this should be fixed by
  // entering rates, never by drifting upward. If it grows, rates are going missing.
  atMost(sum.unpricedShifts, 22, 'db: no more than the 22 known shifts with no rate')

  // Cross-check gross labor with an independent summation.
  let independent = 0
  for (const r of raw) {
    if (r.is_deleted === true || !r.end_at) continue
    const rate = Number(r.hourly_rate ?? 0)
    if (!(rate > 0)) continue
    const hours =
      (new Date(String(r.end_at)).getTime() - new Date(String(r.start_at)).getTime()) / 3_600_000 -
      Number(r.unpaid_break_minutes ?? 0) / 60
    independent += hours * rate
  }
  near(sum.estimatedGrossLabor, Math.round(independent * 100) / 100, 'db: gross labor reconciles to an independent sum', 0.02)

  // Payable hours must be strictly less than on-clock: unpaid breaks exist.
  if (sum.payableHours < sum.onClockHours) pass++
  else {
    fail++
    failures.push('db: payable hours should be below on-clock hours (unpaid breaks)')
  }

  // A suspiciously round total is the signature of a silent row cap.
  if (shifts.length % 1000 !== 0) pass++
  else {
    fail++
    failures.push(`db: shift count ${shifts.length} is an exact multiple of 1000 — likely a truncated read`)
  }

  const { rows: salesRows } = await (async () => {
    const out: { saleDate: string; netSales: number }[] = []
    for (let page = 0; ; page += 1) {
      const { data, error } = await db
        .from('sales_daily')
        .select('sale_date, net_sales, source')
        .order('sale_date', { ascending: true })
        .range(page * 1000, page * 1000 + 999)
      if (error) throw new Error(error.message)
      const batch = data ?? []
      for (const r of batch) {
        out.push({ saleDate: String(r.sale_date), netSales: Number(r.net_sales ?? 0) })
      }
      if (batch.length < 1000) break
    }
    return { rows: out }
  })()

  const coverage = deriveSalesCoverage(salesRows)
  const monthly = deriveMonthlyLabor(shifts, coverage)

  // The specific month the owner told us to stop trusting.
  const july2024 = monthly.find((m) => m.monthKey === '2024-07')
  eq(july2024?.partial, true, 'db: 2024-07 flagged partial')
  eq(july2024?.laborPct, null, 'db: the misleading 2024-07 ratio is suppressed')

  // Months predating the sales feed carry labor but no ratio.
  const may2024 = monthly.find((m) => m.monthKey === '2024-05')
  eq(may2024?.coverage, 'none', 'db: 2024-05 has no sales coverage')
  eq(may2024?.laborPct, null, 'db: no ratio without sales')
  if ((may2024?.estimatedGrossLabor ?? 0) > 0) pass++
  else {
    fail++
    failures.push('db: 2024-05 should still report its labor cost')
  }

  const headline = latestCompleteLaborMonth(monthly)
  if (headline && !headline.partial && headline.laborPct != null) pass++
  else {
    fail++
    failures.push('db: expected a complete headline month with a real labor %')
  }

  /*
   * Dashboard consistency. The payroll pillar must read the SAME headline
   * month the Payroll page shows, and must never be driven by the range-wide
   * average or a partial month. These guard the wiring in getHealthSnapshot.
   */
  const settingsRow = await db
    .from('business_settings')
    .select('setting_key, value')
    .in('setting_key', ['target_payroll_pct', 'warning_payroll_pct'])
  const settingByKey = new Map(
    (settingsRow.data ?? []).map((r) => [String(r.setting_key), Number(r.value)]),
  )
  const target = settingByKey.get('target_payroll_pct')
  const warning = settingByKey.get('warning_payroll_pct')

  // The thresholds must come from the owner's settings, never a literal.
  if (target != null && target > 0) pass++
  else {
    fail++
    failures.push('db: target_payroll_pct missing — the pillar would compare against a hardcoded target')
  }
  if (warning != null && warning > 0) pass++
  else {
    fail++
    failures.push('db: warning_payroll_pct missing')
  }

  // The dashboard value is the headline month's ratio, not the range average.
  const rangeWidePct =
    coverage.netByMonth.size > 0
      ? (sum.estimatedGrossLabor /
          [...coverage.netByMonth.values()].reduce((a, b) => a + b, 0)) *
        100
      : 0
  const dashboardPct = headline?.laborPct ?? 0
  if (dashboardPct > 0 && Math.abs(dashboardPct - rangeWidePct) > 0.01) pass++
  else if (dashboardPct <= 0) {
    fail++
    failures.push('db: dashboard payroll pillar would render 0% and read as "unknown"')
  } else {
    fail++
    failures.push('db: dashboard % equals the range-wide average — it should be the latest complete month')
  }

  // A partial month must never become the dashboard headline.
  if (headline && !headline.partial) pass++
  else {
    fail++
    failures.push('db: dashboard headline month is partial — sales would be understated')
  }

  const pillarStatus =
    dashboardPct <= 0
      ? 'unknown'
      : warning != null && dashboardPct >= warning
        ? 'red'
        : target != null && dashboardPct >= target
          ? 'yellow'
          : 'green'
  // Unpriced hours make the ratio a floor, so a green light is provisional.
  if (sum.unpricedHours > 0 && pillarStatus === 'green') {
    console.log(
      `\nNote: pillar reads green at ${dashboardPct.toFixed(2)}% but ${sum.unpricedHours.toFixed(0)}h are unpriced — the true ratio is higher.`,
    )
  }

  /*
   * Advisor insights. The owner acts on these sentences, so verify the labor
   * facts actually reach the advisor and that the data-quality caveats appear
   * whenever the underlying numbers are incomplete.
   */
  const laborInput: LaborInsightInput = {
    laborPct: headline?.laborPct ?? null,
    monthLabel: headline?.month ?? null,
    estimatedGrossLabor: sum.estimatedGrossLabor,
    payableHours: sum.payableHours,
    overtimeHours: sum.overtimeHours,
    estimatedOvertimeCost: sum.estimatedOvertimeCost,
    unpricedHours: sum.unpricedHours,
    unpricedShifts: sum.unpricedShifts,
    unpricedBy: sum.unpricedBy,
    likelyMissedClockOuts: sum.likelyMissedClockOuts,
    salesPerLaborHour: headline?.salesPerLaborHour ?? null,
    // Same trio the dashboard and report render, so the trend insight is
    // exercised against the owner's real numbers rather than only fixtures.
    rolling3Pct: laborPctWindow(monthly, 3).laborPct,
    rolling3Months: laborPctWindow(monthly, 3).monthsCounted,
    allTimePct: laborPctWindow(monthly, null).laborPct,
    allTimeMonths: laborPctWindow(monthly, null).monthsCounted,
  }
  const liveSettings = {
    ...SETTING_DEFAULTS,
    target_payroll_pct: target ?? SETTING_DEFAULTS.target_payroll_pct,
    warning_payroll_pct: warning ?? SETTING_DEFAULTS.warning_payroll_pct,
    rows: [],
  }
  const pillarsForAdvisor = {
    payroll: payrollHealth(dashboardPct, liveSettings, dashboardPct > 0),
    cash: { status: 'unknown', label: '', message: '', score: null } as const,
    sales: { status: 'unknown', label: '', message: '', score: null } as const,
  }
  const insights = generateInsights({
    settings: liveSettings,
    pillars: pillarsForAdvisor,
    labor: laborInput,
  })
  const ids = insights.map((i) => i.id)

  // The unpriced-hours warning is the single most important labor insight:
  // without it a green payroll light is quietly wrong.
  if (sum.unpricedHours >= 1) {
    if (ids.includes('auto-labor-unpriced')) pass++
    else {
      fail++
      failures.push('advisor: unpriced hours exist but no unpriced-hours insight was produced')
    }
    // And the green payroll note must not claim an unqualified win.
    const ok = insights.find((i) => i.id === 'auto-payroll-ok')
    if (!ok || /provisional/i.test(ok.detail)) pass++
    else {
      fail++
      failures.push('advisor: payroll-ok insight reads as a clean win despite uncosted hours')
    }
    // The insight should name who to fix, not just a count.
    const unpriced = insights.find((i) => i.id === 'auto-labor-unpriced')
    if (unpriced && /Guidry|Naquin|Owner/i.test(unpriced.detail)) pass++
    else {
      fail++
      failures.push('advisor: unpriced insight does not say whose hours are uncosted')
    }
  }

  if (sum.likelyMissedClockOuts > 0) {
    if (ids.includes('auto-labor-missed-clockouts')) pass++
    else {
      fail++
      failures.push('advisor: missed clock-outs exist but no insight was produced')
    }
  }

  if (sum.overtimeHours >= 1) {
    if (ids.includes('auto-labor-overtime')) pass++
    else {
      fail++
      failures.push('advisor: overtime exists but no overtime insight was produced')
    }
  }

  // No labor group at all must yield no labor insights — never invented ones.
  const emptyAdvisor = generateInsights({
    settings: liveSettings,
    pillars: pillarsForAdvisor,
  })
  if (!emptyAdvisor.some((i) => i.id.startsWith('auto-labor-'))) pass++
  else {
    fail++
    failures.push('advisor: labor insights appeared without any labor data')
  }

  console.log(`\nAdvisor labor insights: ${ids.filter((i) => i.startsWith('auto-labor-') || i.startsWith('auto-payroll-')).join(', ')}`)

  console.log(`\nDashboard payroll pillar: ${dashboardPct.toFixed(2)}% (${headline?.month}) vs target ${target}% / warning ${warning}% → ${pillarStatus}`)
  console.log(`Range-wide average would have been ${rangeWidePct.toFixed(2)}% — correctly not used.`)

  /*
   * The three windows on live data. All surfaces show the same trio, so they must
   * agree — and the headline must remain the headline, not silently become one of
   * the averages.
   */
  const liveRolling3 = laborPctWindow(monthly, 3)
  const liveAllTime = laborPctWindow(monthly, null)

  if (liveRolling3.monthsCounted <= 3) pass++
  else {
    fail++
    failures.push(`windows: rolling window covers ${liveRolling3.monthsCounted} months, more than the 3 requested`)
  }

  // The all-time window must cover every complete month and no partial ones.
  const completeCount = monthly.filter((m) => !m.partial && m.netSales != null).length
  if (liveAllTime.monthsCounted === completeCount) pass++
  else {
    fail++
    failures.push(`windows: all-time covers ${liveAllTime.monthsCounted} months but ${completeCount} are complete`)
  }

  // The headline must differ from both averages here, which is the whole reason
  // for showing all three. If they collapse to one number the display is
  // redundant and the earlier concern about hiding a bad month was unfounded.
  if (
    liveAllTime.laborPct != null &&
    Math.abs(dashboardPct - liveAllTime.laborPct) > 0.01
  ) pass++
  else {
    fail++
    failures.push('windows: headline month equals the all-time rate — verify the headline is still the month, not an average')
  }

  // Dollar-weighting check: the all-time figure must not equal the plain mean of
  // the monthly percentages, or the weighting was lost somewhere.
  const completeMonths = monthly.filter((m) => !m.partial && m.laborPct != null)
  const meanOfPcts =
    completeMonths.reduce((a, m) => a + (m.laborPct ?? 0), 0) / completeMonths.length
  if (
    liveAllTime.laborPct != null &&
    Math.abs(liveAllTime.laborPct - meanOfPcts) > 0.01
  ) pass++
  else {
    fail++
    failures.push(
      `windows: all-time ${liveAllTime.laborPct?.toFixed(2)}% matches the unweighted mean ${meanOfPcts.toFixed(2)}% — dollar weighting appears lost`,
    )
  }

  console.log(
    `Windows → headline ${dashboardPct.toFixed(2)}% (${headline?.month}) · last ${liveRolling3.monthsCounted} mo ${liveRolling3.laborPct?.toFixed(2)}% · all ${liveAllTime.monthsCounted} mo ${liveAllTime.laborPct?.toFixed(2)}% (unweighted mean would be ${meanOfPcts.toFixed(2)}%)`,
  )

  /*
   * Reporting reconciliation (rule 18's third consumer). The report's Total row
   * is what gets checked against Square's own payroll export, so the monthly
   * rows must sum to the same figure the summary reports — and the Payroll page
   * and Dashboard must agree with both.
   */
  const monthlySumLabor = monthly.reduce((a, m) => a + m.estimatedGrossLabor, 0)
  // Tolerance is one cent PER MONTHLY ROW, not one cent overall. Both sides add up
  // ~2,800 non-terminating binary floats (hours x rate) in a different ORDER — the
  // summary over all shifts, the report per month then across months — so they can
  // legitimately differ by a fraction of a cent per grouping. A flat 0.01 made this
  // fail at $205,163.14 vs $205,163.13, which is float addition, not a
  // reconciliation error, and it got worse as months accumulated.
  //
  // Still tight enough to do its job: a genuine bug (a month dropped from the
  // report, a shift counted twice) moves this by dollars, not fractions of a cent.
  const laborTol = Math.max(0.01, monthly.length * 0.01)
  if (Math.abs(monthlySumLabor - sum.estimatedGrossLabor) < laborTol) pass++
  else {
    fail++
    failures.push(
      `reporting: monthly rows sum to $${monthlySumLabor.toFixed(2)} but the summary total is $${sum.estimatedGrossLabor.toFixed(2)} (differ by $${Math.abs(monthlySumLabor - sum.estimatedGrossLabor).toFixed(4)}, tolerance $${laborTol.toFixed(2)})`,
    )
  }

  const monthlySumHours = monthly.reduce((a, m) => a + m.payableHours, 0)
  if (Math.abs(monthlySumHours - sum.payableHours) < 0.05) pass++
  else {
    fail++
    failures.push(
      `reporting: monthly payable hours sum to ${monthlySumHours.toFixed(2)} but the summary says ${sum.payableHours.toFixed(2)}`,
    )
  }

  // Partial months must show cost but never a percentage, on every surface.
  const partialWithPct = monthly.filter((m) => m.partial && m.laborPct != null)
  if (partialWithPct.length === 0) pass++
  else {
    fail++
    failures.push(
      `reporting: ${partialWithPct.map((m) => m.monthKey).join(', ')} are partial yet expose a labor % — the ratio would be inflated`,
    )
  }

  // Every partial month must still contribute its labor cost, or the Total
  // would silently under-report what was actually paid out.
  const partialWithoutCost = monthly.filter(
    (m) => m.partial && m.estimatedGrossLabor <= 0 && m.payableHours > 0,
  )
  if (partialWithoutCost.length === 0) pass++
  else {
    fail++
    failures.push(
      `reporting: ${partialWithoutCost.map((m) => m.monthKey).join(', ')} have hours but no cost in the Total`,
    )
  }

  // The dashboard's headline month must be one of the reported rows, so the
  // owner can always trace the pillar's 14.1% back to a line in the table.
  if (!headline || monthly.some((m) => m.monthKey === headline.monthKey)) pass++
  else {
    fail++
    failures.push('reporting: dashboard headline month is absent from the report table')
  }

  console.log(
    `\nReporting: monthly rows sum to $${monthlySumLabor.toFixed(2)} / ${monthlySumHours.toFixed(1)} h — reconciles with the summary total.`,
  )

  console.log(`\nLive data: ${shifts.length} shifts, ${sum.payableHours.toFixed(2)} payable hours, $${sum.estimatedGrossLabor.toFixed(2)} estimated gross labor.`)
  console.log(`Sales feed ${coverage.firstDate} to ${coverage.lastDate}.`)
  console.log(`Headline complete month: ${headline?.month} at ${headline?.laborPct}% labor, $${headline?.salesPerLaborHour}/labor hour.`)
  console.log(`Overtime: ${sum.overtimeHours}h, estimated premium $${sum.estimatedOvertimeCost}.`)
  console.log(`Unpriced: ${sum.unpricedShifts} shifts, ${sum.unpricedHours}h — ${sum.unpricedBy.map((u) => u.label).join(', ')}.`)
  console.log(`Partial months: ${monthly.filter((m) => m.partial).map((m) => m.monthKey).join(', ')}`)
}

reconcile()
  .catch((e) => {
    fail++
    failures.push(`db reconciliation threw: ${e instanceof Error ? e.message : String(e)}`)
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`)
    if (failures.length > 0) {
      console.log('\nFailures:')
      for (const f of failures) console.log(`  - ${f}`)
      process.exit(1)
    }
  })
