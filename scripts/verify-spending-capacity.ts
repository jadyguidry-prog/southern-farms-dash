/**
 * Checks for the spending-capacity engine (daily budget + 7-day forecast).
 *
 * Each block below pins a rule that was derived from the real ledger. They are
 * written as regression tests because every one of these traps produced a
 * plausible-looking but wrong dollar figure during development:
 *   - a $36,416 Square Capital advance reading as a record sales week
 *   - "Transfer From Acct" (money arriving) being booked as spending
 *   - a one-off $32k check dragging the weekly average for months
 *   - obligations charged twice: once estimated, once on their due date
 *
 * Run: npx tsx scripts/verify-spending-capacity.ts
 */
import {
  classifyFlow,
  buildWeeklyFlows,
  estimateWeeklyFlow,
  buildDayOfWeekProfile,
  deriveSpendingCapacity,
  assessConfidence,
  quantile,
  isoDayOfWeek,
  weekStart,
  addDays,
  type LedgerRow,
  type FlowEstimate,
} from '../lib/spending-capacity-service'
import { generateInsights } from '../lib/health'

let pass = 0
let fail = 0
const failures: string[] = []

function check<T>(label: string, actual: T, expected: T) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    failures.push(`${label}: expected ${e}, got ${a}`)
  }
}
function ok(label: string, cond: boolean) {
  if (cond) pass++
  else {
    fail++
    failures.push(label)
  }
}
function approx(label: string, actual: number, expected: number, tol: number) {
  if (Math.abs(actual - expected) <= tol) pass++
  else {
    fail++
    failures.push(`${label}: expected ~${expected} (±${tol}), got ${actual}`)
  }
}

const CHECKING = 'South Lafourche Bank Checking ending 2268'
const AMEX = 'American Express ending 0-73009'
const ACCOUNTS = [CHECKING, 'Square Balance', 'Square Savings']

const row = (r: Partial<LedgerRow> = {}): LedgerRow => ({
  date: '2026-07-06',
  amount: 1000,
  type: 'income',
  description: 'DEPOSIT',
  accountName: CHECKING,
  ...r,
})

// ---------------------------------------------------------------------------
console.log('Classifying what actually moves cash')

check('a checking deposit is money in', classifyFlow(row(), ACCOUNTS), 'in')
check(
  'a checking expense is money out',
  classifyFlow(row({ type: 'expense', description: 'CHECK # 1617' }), ACCOUNTS),
  'out',
)

// A card purchase does not move cash; the payoff from checking does. Counting
// both would double-count the same dollars.
check(
  'a credit-card purchase is ignored, not spending',
  classifyFlow(row({ accountName: AMEX, type: 'expense' }), ACCOUNTS),
  'ignored',
)
check(
  'the card payoff FROM checking is real spending',
  classifyFlow(
    row({ type: 'payment', description: 'AMERICAN EXPRESS ACH PMT' }),
    ACCOUNTS,
  ),
  'out',
)

// The exact row that broke the first attempt: an advance that looks like sales.
check(
  'a Square Capital advance is financing, not sales',
  classifyFlow(
    row({ amount: 36416, description: 'Square Inc SQ CAP5725 T36MWS7R8H646TE' }),
    ACCOUNTS,
  ),
  'financing',
)
check(
  'a real Square settlement IS sales',
  classifyFlow(
    row({ description: 'Square Inc SQ260729 T3Y9WV349DM8FHS' }),
    ACCOUNTS,
  ),
  'in',
)

// Transfer rows are stored POSITIVE in both directions, so direction has to be read
// from the wording. It cannot be ignored: the counterpart accounts are absent from
// this ledger and real transfers are asymmetric (~$21k in vs ~$43k out), so treating
// them as net-zero deletes real cash and drives a reconstructed balance negative.
check(
  'an outbound internal transfer is not spending',
  classifyFlow(
    row({ type: 'transfer', description: 'Internet Transfer to Acct# 2008275' }),
    ACCOUNTS,
  ),
  'internal_out',
)
check(
  'an INBOUND internal transfer is distinguished from an outbound one',
  classifyFlow(
    row({ type: 'transfer', description: 'Internet Transfer From Acct 2008275' }),
    ACCOUNTS,
  ),
  'internal_in',
)
check(
  'a Square Financial Services transfer is internal',
  classifyFlow(
    row({ type: 'transfer', description: 'Square Fin Svcs Transfer 35121567799' }),
    ACCOUNTS,
  ),
  'internal_out',
)
check(
  'a deposit "from savings" is internal, never revenue',
  classifyFlow(
    row({ type: 'credit', description: 'Internet Transfer From Savings 9021' }),
    ACCOUNTS,
  ),
  'internal_in',
)

// ---------------------------------------------------------------------------
console.log('\nWeekly buckets and robust estimates')

check('Monday is ISO day 1', isoDayOfWeek('2026-08-03'), 1)
check('Sunday is ISO day 7', isoDayOfWeek('2026-08-02'), 7)
check('week starts on Monday', weekStart('2026-08-02'), '2026-07-27')

{
  // Four complete weeks of steady trade, plus the in-progress week.
  const rows: LedgerRow[] = []
  for (const wk of ['2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20']) {
    rows.push(row({ date: wk, amount: 10_000, type: 'income' }))
    rows.push(row({ date: addDays(wk, 1), amount: 6_000, type: 'expense' }))
  }
  // The current week is only one day old; counting it would look like collapse.
  rows.push(row({ date: '2026-08-03', amount: 500, type: 'income' }))

  const weeks = buildWeeklyFlows(rows, {
    operatingAccounts: ACCOUNTS,
    today: '2026-08-03',
  })
  check('only complete weeks are counted', weeks.length, 4)
  ok(
    'the in-progress week is excluded',
    weeks.every((w) => w.weekStart < '2026-08-03'),
  )

  const est = estimateWeeklyFlow(weeks)
  check('typical weekly income', est.typicalInflow, 10_000)
  check('typical weekly spend', est.typicalOutflow, 6_000)
}

{
  // The June 8 event: one freak week must not move the estimate.
  const weeksIn = [12_000, 11_000, 13_000, 12_500, 90_000]
  const rows = weeksIn.map((amt, i) =>
    row({ date: addDays('2026-06-01', i * 7), amount: amt, type: 'income' }),
  )
  const weeks = buildWeeklyFlows(rows, {
    operatingAccounts: ACCOUNTS,
    today: '2026-07-13',
  })
  const est = estimateWeeklyFlow(weeks)
  ok(
    'a single freak week does not inflate the typical figure',
    est.typicalInflow >= 11_000 && est.typicalInflow <= 13_000,
  )
  ok('the cautious figure is never above the typical one', est.cautiousInflow <= est.typicalInflow)
}

{
  // Obligations modeled on their real due dates must be stripped from the
  // estimated baseline, or the same bill is charged twice.
  const rows = [
    row({ date: '2026-07-06', amount: 5_000, type: 'expense', description: 'SYSCO BROS ACH' }),
    row({ date: '2026-07-07', amount: 1_000, type: 'expense', description: 'MISC SUPPLY CO' }),
  ]
  const withAll = buildWeeklyFlows(rows, {
    operatingAccounts: ACCOUNTS,
    today: '2026-07-20',
  })
  const excluded = buildWeeklyFlows(rows, {
    operatingAccounts: ACCOUNTS,
    today: '2026-07-20',
    excludeMatchers: ['Sysco'],
  })
  check('baseline includes everything by default', withAll[0]?.outflow, 6_000)
  check('an explicitly-modeled vendor is removed from the baseline', excluded[0]?.outflow, 1_000)

  // A short matcher could match almost anything; guard against that.
  const tooShort = buildWeeklyFlows(rows, {
    operatingAccounts: ACCOUNTS,
    today: '2026-07-20',
    excludeMatchers: ['CO'],
  })
  check('a too-short matcher is ignored rather than nuking the baseline', tooShort[0]?.outflow, 6_000)
}

check('quantile of an empty list is 0, not NaN', quantile([], 0.5), 0)
check('quantile of one value is that value', quantile([42], 0.25), 42)
check('median of an even list interpolates', quantile([10, 20, 30, 40], 0.5), 25)

// ---------------------------------------------------------------------------
console.log('\nMoney does not arrive evenly across the week')

{
  // Real pattern: deposits land Mon-Fri, nothing at the weekend.
  const rows: LedgerRow[] = [
    row({ date: '2026-07-06', amount: 4_329 }), // Mon
    row({ date: '2026-07-07', amount: 2_629 }), // Tue
    row({ date: '2026-07-08', amount: 3_279 }), // Wed
    row({ date: '2026-07-09', amount: 3_100 }), // Thu
    row({ date: '2026-07-10', amount: 4_021 }), // Fri
  ]
  const { shares, hasProfile } = buildDayOfWeekProfile(rows, {
    operatingAccounts: ACCOUNTS,
  })
  ok('a profile is produced', hasProfile)
  approx('shares sum to 1', Object.values(shares).reduce((s, v) => s + v, 0), 1, 1e-9)
  check('Saturday expects nothing', shares[6], 0)
  check('Sunday expects nothing', shares[7], 0)
  ok('Monday carries the biggest share', shares[1] > shares[2])

  // Card purchases must not contribute to the income shape.
  const polluted = buildDayOfWeekProfile(
    [...rows, row({ date: '2026-07-11', amount: 50_000, accountName: AMEX })],
    { operatingAccounts: ACCOUNTS },
  )
  check('a card row cannot invent Saturday income', polluted.shares[6], 0)
}

check(
  'no history means no invented pattern',
  buildDayOfWeekProfile([], { operatingAccounts: ACCOUNTS }).hasProfile,
  false,
)

// ---------------------------------------------------------------------------
console.log('\nThe 7-day projection and the headline number')

const evenShares = { 1: 1 / 5, 2: 1 / 5, 3: 1 / 5, 4: 1 / 5, 5: 1 / 5, 6: 0, 7: 0 }
// Declared as a function, not an arrow returning a parenthesised object: the
// bare `{ ... }` scoping blocks used below would otherwise make tsc re-parse
// `({ ... })` as an arrow parameter list. esbuild/tsx tolerates it, tsc does not.
function est(o: Partial<FlowEstimate> = {}): FlowEstimate {
  return {
    typicalInflow: 17_500,
    cautiousInflow: 14_000,
    typicalOutflow: 16_000,
    weeksObserved: 12,
    ...o,
  }
}

{
  const r = deriveSpendingCapacity({
    cashOnHand: 18_846,
    minCashReserve: 15_000,
    today: '2026-08-03',
    estimate: est(),
    shares: evenShares,
    datedOutflows: [],
    baselineWeeklyOutflow: 0,
  })
  check('seven days are projected', r.days.length, 7)
  check('the projection starts on the given day', r.days[0]?.date, '2026-08-03')
  ok(
    'the cautious line is never above the typical line',
    r.days.every((d) => d.cautiousBalance <= d.typicalBalance),
  )
  check('no income is expected on Saturday', r.days[5]?.cautiousIn, 0)
  check('no income is expected on Sunday', r.days[6]?.cautiousIn, 0)

  // The typical low point is CONTEXT ONLY. If it ever starts driving the headline or the
  // breach flag, the panel stops being safe in a bad week — which is the entire reason the
  // cautious basis exists.
  ok(
    'the typical low point is never below the cautious one',
    r.typicalLowestBalance >= r.lowestBalance,
  )
  ok(
    'the typical low point matches a day actually projected',
    r.days.some(
      (d) =>
        d.date === r.typicalLowestBalanceDate && d.typicalBalance === r.typicalLowestBalance,
    ),
  )
}

{
  // The two scenarios can bottom out on DIFFERENT days. Reading the typical balance off the
  // cautious trough's date would print a figure that appears nowhere in the projection, so
  // each date is tracked independently.
  const r = deriveSpendingCapacity({
    cashOnHand: 30_000,
    minCashReserve: 15_000,
    today: '2026-08-03',
    estimate: est({ typicalInflow: 21_000, cautiousInflow: 7_000 }),
    shares: evenShares,
    datedOutflows: [{ date: '2026-08-07', amount: 12_000, label: 'Vendor draft' }],
    baselineWeeklyOutflow: 14_000,
    horizonDays: 7,
    nearTermDays: 7,
  })
  ok(
    'each scenario reports its own trough date and value',
    r.days.some(
      (d) =>
        d.date === r.typicalLowestBalanceDate && d.typicalBalance === r.typicalLowestBalance,
    ) &&
      r.days.some((d) => d.date === r.lowestBalanceDate && d.cautiousBalance === r.lowestBalance),
  )
  // The actual regression risk: now that a rosier figure sits beside it, the headline must
  // keep answering the cautious question.
  check(
    'the headline still solves against the cautious trough',
    r.safeToSpendToday,
    Math.max(0, Math.round((r.nearTermLowestBalance - 15_000) * 100) / 100),
  )
}

{
  // Starting point must be RAW cash. Outstanding items are subtracted on their
  // own dates; starting from the already-netted "spendable" figure would
  // subtract them twice.
  const r = deriveSpendingCapacity({
    cashOnHand: 20_000,
    minCashReserve: 0,
    today: '2026-08-03',
    estimate: est({ cautiousInflow: 0, typicalInflow: 0 }),
    shares: evenShares,
    datedOutflows: [{ date: '2026-08-05', amount: 5_000, label: 'Check #1670' }],
    baselineWeeklyOutflow: 0,
  })
  check('cash is untouched before the item lands', r.days[1]?.cautiousBalance, 20_000)
  check('the item is subtracted on its own date', r.days[2]?.cautiousBalance, 15_000)
  check('and only once', r.days[6]?.cautiousBalance, 15_000)
  ok(
    'the item is named so the figure can be explained',
    r.days[2]?.items.some((i) => i.label === 'Check #1670'),
  )
}

{
  // An overdue item is still owed; it must not be treated as already gone.
  const r = deriveSpendingCapacity({
    cashOnHand: 10_000,
    minCashReserve: 0,
    today: '2026-08-03',
    estimate: est({ cautiousInflow: 0, typicalInflow: 0 }),
    shares: evenShares,
    datedOutflows: [{ date: '2026-07-01', amount: 2_000, label: 'Overdue bill' }],
    baselineWeeklyOutflow: 0,
  })
  check('an overdue item lands today', r.days[0]?.cautiousBalance, 8_000)

  // Landing it on today is right, but the ORIGINAL date must survive. Without it a
  // months-stale bill is indistinguishable from one genuinely due today, and today's
  // total reads as a big spending day when it is really a backlog.
  const overdue = r.days[0]?.items.find((i) => i.label === 'Overdue bill')
  check('the original due date is preserved', overdue?.dueDate, '2026-07-01')
  check('and how overdue it is, is stated', overdue?.daysOverdue, 33)
}

{
  // An item due on the day it appears must NOT be labelled overdue, or the warning
  // becomes noise and gets ignored on the days it matters.
  const r = deriveSpendingCapacity({
    cashOnHand: 10_000,
    minCashReserve: 0,
    today: '2026-08-03',
    estimate: est({ cautiousInflow: 0, typicalInflow: 0 }),
    shares: evenShares,
    datedOutflows: [
      { date: '2026-08-03', amount: 500, label: 'Due today' },
      { date: '2026-07-31', amount: 250, label: 'Late bill' },
    ],
    baselineWeeklyOutflow: 700,
  })
  const items = r.days[0]?.items ?? []
  const dueToday = items.find((i) => i.label === 'Due today')
  const late = items.find((i) => i.label === 'Late bill')
  check('an item due today is not overdue', dueToday?.daysOverdue, 0)
  check('its due date is still recorded', dueToday?.dueDate, '2026-08-03')
  check('a late item is marked overdue', late?.daysOverdue, 3)

  // The spread estimate is not a bill. Giving it a due date would let the UI present an
  // average as though it were a specific invoice.
  const estimateItem = items.find((i) => i.kind === 'estimate')
  ok('the estimate carries no due date', estimateItem?.dueDate === null)
  check('and is never overdue', estimateItem?.daysOverdue, 0)

  // The breakdown must reconcile to the displayed total, or the expander contradicts
  // the row it explains.
  const sum = items.reduce((s, i) => s + i.amount, 0)
  ok(
    'the itemised breakdown sums to the day total',
    Math.abs(sum - (r.days[0]?.moneyOut ?? 0)) < 0.005,
  )
}

{
  // Day counts must hold across a DST boundary (US DST ends 1 Nov 2026). A local
  // timestamp subtraction gives 25 hours for one of these days and truncates to the
  // wrong number of days.
  const r = deriveSpendingCapacity({
    cashOnHand: 10_000,
    minCashReserve: 0,
    today: '2026-11-03',
    estimate: est({ cautiousInflow: 0, typicalInflow: 0 }),
    shares: evenShares,
    datedOutflows: [{ date: '2026-10-30', amount: 100, label: 'Across DST' }],
    baselineWeeklyOutflow: 0,
  })
  check(
    'days overdue is exact across a DST change',
    r.days[0]?.items.find((i) => i.label === 'Across DST')?.daysOverdue,
    4,
  )
}

{
  // The headline must use the WORST point in the week. A big Friday must not
  // hide a Wednesday that cannot cover the bills.
  const r = deriveSpendingCapacity({
    cashOnHand: 20_000,
    minCashReserve: 5_000,
    today: '2026-08-03',
    estimate: est({ cautiousInflow: 0, typicalInflow: 0 }),
    shares: evenShares,
    datedOutflows: [
      { date: '2026-08-05', amount: 12_000, label: 'Payroll' },
      // Money arriving later cannot undo a mid-week dip.
    ],
    baselineWeeklyOutflow: 0,
  })
  check('the lowest point is found', r.lowestBalance, 8_000)
  check('and dated correctly', r.lowestBalanceDate, '2026-08-05')
  check('safe to spend is measured from the dip', r.safeToSpendToday, 3_000)
  // Rounded to cents: this is money the owner will act on, not a raw float.
  check('the daily pace divides the headline', r.perDayAllowance, 428.57)
}

{
  // Below reserve: the answer must be zero, not a negative "allowance".
  const r = deriveSpendingCapacity({
    cashOnHand: 16_000,
    minCashReserve: 15_000,
    today: '2026-08-03',
    estimate: est({ cautiousInflow: 0, typicalInflow: 0 }),
    shares: evenShares,
    datedOutflows: [{ date: '2026-08-04', amount: 4_000, label: 'Rent' }],
    baselineWeeklyOutflow: 0,
  })
  check('nothing is safe to spend', r.safeToSpendToday, 0)
  check('the daily pace is zero too', r.perDayAllowance, 0)
  ok('the reserve breach is reported', r.breachesReserve)
  check('the shortfall is quantified', r.reserveShortfall, 3_000)
  ok('the breaching day is flagged', r.days[1]?.breachesReserve === true)
}

{
  // Day-to-day running costs are spread, and shown as their own line so the
  // owner can see why the number is lower than the bills alone suggest.
  const r = deriveSpendingCapacity({
    cashOnHand: 30_000,
    minCashReserve: 0,
    today: '2026-08-03',
    estimate: est({ cautiousInflow: 0, typicalInflow: 0 }),
    shares: evenShares,
    datedOutflows: [],
    baselineWeeklyOutflow: 7_000,
  })
  check('the weekly baseline is spread across seven days', r.days[0]?.moneyOut, 1_000)
  check('and fully consumed over the week', r.days[6]?.cautiousBalance, 23_000)
  ok(
    'running costs appear as a named line',
    r.days[0]?.items.some((i) => i.label === 'Day-to-day running costs'),
  )
}

// ---------------------------------------------------------------------------
console.log('\nRefusing to answer when the data cannot support it')

check(
  'too little history is reported honestly',
  assessConfidence({
    weeksObserved: 2,
    hasProfile: true,
    lastLedgerDate: '2026-08-01',
    today: '2026-08-03',
  }),
  { level: 'insufficient-history', weeksObserved: 2 },
)
check(
  'no income pattern is reported honestly',
  assessConfidence({
    weeksObserved: 12,
    hasProfile: false,
    lastLedgerDate: '2026-08-01',
    today: '2026-08-03',
  }),
  { level: 'no-income-pattern' },
)
check(
  'a stale ledger is reported rather than silently projected',
  assessConfidence({
    weeksObserved: 12,
    hasProfile: true,
    lastLedgerDate: '2026-07-01',
    today: '2026-08-03',
  }),
  { level: 'stale-data', daysStale: 33 },
)
check(
  'fresh, sufficient data is usable',
  assessConfidence({
    weeksObserved: 12,
    hasProfile: true,
    lastLedgerDate: '2026-08-01',
    today: '2026-08-03',
  }),
  { level: 'ok' },
)

// ---------------------------------------------------------------------------
console.log('\nEnd to end, with the real shape of the business')

{
  // Roughly the live position: ~$18.8k cash, $15k reserve, ~$17.4k/wk in,
  // ~$16.4k/wk out. Cash sits only a little above reserve, so the honest
  // answer is a small number — that is the point of the feature.
  const shares = { 1: 0.249, 2: 0.151, 3: 0.189, 4: 0.179, 5: 0.232, 6: 0, 7: 0 }
  const r = deriveSpendingCapacity({
    cashOnHand: 18_846,
    minCashReserve: 15_000,
    today: '2026-08-03',
    estimate: est({ typicalInflow: 17_358, cautiousInflow: 13_900, typicalOutflow: 16_395 }),
    shares,
    datedOutflows: [],
    baselineWeeklyOutflow: 16_395,
  })
  ok('the headline is never negative', r.safeToSpendToday >= 0)
  ok(
    'a tight cash position produces a small or zero allowance',
    r.safeToSpendToday < 5_000,
  )
  ok(
    'every day is accounted for with an explanation',
    r.days.every((d) => d.items.length > 0 || d.moneyOut === 0),
  )
  // Arithmetic the UI shows must tie out, or the table contradicts the headline.
  const first = r.days[0]!
  approx(
    'the running balance ties to in minus out',
    first.cautiousBalance,
    18_846 + first.cautiousIn - first.moneyOut,
    0.02,
  )
}

// ---------------------------------------------------------------------------
// The weekly position also has to reach the AI Advisor. The deficit warning is
// the most consequential sentence this feature produces, so the conditions
// under which it fires — and stays silent — are pinned here.
console.log('\nThe advisor insight built from the weekly position')

{
  const advisorSettings = {
    min_cash_reserve: 0,
    target_payroll_pct: 25,
    warning_payroll_pct: 30,
    minimum_weekly_sales: 20000,
    preferred_weekly_sales: 30000,
  } as unknown as Parameters<typeof generateInsights>[0]['settings']

  // Pillars forced to `unknown` so they emit nothing and only our ids remain.
  const advisorPillars = {
    payroll: { status: 'unknown', label: 'Unknown', message: '' },
    cash: { status: 'unknown', label: 'Unknown', message: '' },
    sales: { status: 'unknown', label: 'Unknown', message: '' },
  } as never

  type SpendingArg = Parameters<typeof generateInsights>[0]['spending']
  const build = (spending?: SpendingArg) =>
    generateInsights({ settings: advisorSettings, pillars: advisorPillars, spending })
  const ids = (spending?: SpendingArg) =>
    build(spending)
      .filter((i) => i.id.startsWith('auto-weekly-cash-'))
      .map((i) => i.id)
      .sort()

  // Deficit-shaped figures in the farm's ballpark. Deliberately NOT labelled as
  // the live numbers: the app currently shows $13,603 in / $14,185 out with
  // $1,437 spare, because dated bills are excluded from the baseline there.
  // These are fixed inputs chosen to exercise the branch, so the assertions stay
  // stable as the real ledger moves. Read live figures off the app.
  const real = {
    typicalWeeklyInflow: 13_095,
    typicalWeeklyOutflow: 14_381,
    weeksObserved: 45,
    safeToSpendToday: 1_185,
    breachesReserve: false,
  }

  // Silence when there is nothing to judge, matching every other insight group.
  check('no spending group produces no insight', ids(undefined), [])
  // A partially-imported ledger must not yield a verdict on solvency.
  check(
    'fewer than 8 complete weeks produces no verdict',
    ids({ ...real, weeksObserved: 7 }),
    [],
  )
  check(
    'at 8 weeks the verdict appears',
    ids({ ...real, weeksObserved: 8 }),
    ['auto-weekly-cash-deficit'],
  )

  check("the farm's real position warns", ids(real), ['auto-weekly-cash-deficit'])
  check(
    'spending more than you earn is critical, not a gentle nudge',
    build(real).find((i) => i.id === 'auto-weekly-cash-deficit')?.severity,
    'critical',
  )

  // A business that covers its costs gets the opposite framing.
  check(
    'covering costs reads as an opportunity',
    ids({ ...real, typicalWeeklyInflow: 16_000 }),
    ['auto-weekly-cash-surplus'],
  )
  // The branches must be mutually exclusive: never tell the owner they are
  // losing money AND have a surplus in the same list.
  check('exactly one weekly verdict is produced', ids(real).length, 1)

  // The advice must be checkable rather than asserted, so the gap appears in the
  // copy. 14,381 - 13,095 = 1,286.
  const detail = build(real).find((i) => i.id === 'auto-weekly-cash-deficit')?.detail ?? ''
  ok('the weekly gap is quantified in the copy', detail.includes('$1,286'))
  ok(
    'the copy says trimming spending alone only buys time',
    detail.includes('buys time'),
  )

  // At the real position the spare cash ($1,185) is less than one week of the
  // gap ($1,286). Claiming "covers about 0 weeks" would be both confusing and
  // falsely reassuring, so this case gets its own wording.
  ok(
    'under one week of cover is stated plainly, not as "0 weeks"',
    detail.includes('less than a single week') && !detail.includes('0 weeks'),
  )
  ok(
    'it names the reserve as the thing now absorbing the shortfall',
    detail.includes('reserve itself'),
  )

  // With a healthy buffer the runway IS worth quoting: 12,860 / 1,286 = 10.
  const roomy = build({ ...real, safeToSpendToday: 12_860 }).find(
    (i) => i.id === 'auto-weekly-cash-deficit',
  )?.detail ?? ''
  ok('a real runway is stated in whole weeks', roomy.includes('about 10 weeks'))
  // Floored, never rounded up: 12,859 is still only 9 full weeks of cover.
  const justUnder = build({ ...real, safeToSpendToday: 12_859 }).find(
    (i) => i.id === 'auto-weekly-cash-deficit',
  )?.detail ?? ''
  ok('runway is floored rather than rounded up', justUnder.includes('about 9 weeks'))
  ok('a single week is not pluralised', 
    (build({ ...real, safeToSpendToday: 1_500 }).find(
      (i) => i.id === 'auto-weekly-cash-deficit',
    )?.detail ?? '').includes('about 1 week '),
  )
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(` - ${f}`)
  process.exit(1)
}
