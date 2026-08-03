/**
 * Growth Investment Planner — verification of the deterministic math.
 *
 * Exercises the SAME exported functions the page renders. Nothing here
 * re-implements a projection: that drift is how this project once reported a $0
 * reserve when the truth was $15,000.
 *
 * The baseline mirrors Southern Farms' real position as measured Aug 2026, so a
 * threshold that would fail "commit to nothing" shows up here rather than on the
 * owner's screen.
 */

import {
  assessStrategicTiming,
  buildCapacityLadder,
  buildScenarioMatrix,
  evaluateRung,
  maxSupported,
  projectMonths,
  NO_COMMITMENT,
  ONE_TIME_RUNGS,
  RECURRING_RUNGS,
  type CoverageInputs,
  type ProjectionAssumptions,
  type RiskMode,
} from '../lib/growth-planner'

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  ok    ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`)
  }
}

function checkNear(label: string, actual: number, expected: number, tol = 1) {
  if (Math.abs(actual - expected) <= tol) {
    passed++
    console.log(`  ok    ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}\n          expected ~${expected} (±${tol})\n          actual   ${actual}`)
  }
}

function checkTrue(label: string, actual: boolean) {
  check(label, actual, true)
}

/* ------------------------------------------------------------------ */
/* Baseline — Southern Farms, Aug 2026                                 */
/* ------------------------------------------------------------------ */

const BASE: ProjectionAssumptions = {
  cashOnHand: 19614, // $12,571.29 checking + $7,042.65 savings
  expectedReceivables: 0,
  expectedInflow: 58901, // avg of complete months of bank history
  expectedOutflow: 51898,
  horizonMonths: 6,
  startMonthKey: '2026-08',
}

const COV: CoverageInputs = {
  minCashReserve: 15000,
  avgDailyOutflow: 51898 / 30.44,
  monthlyPayroll: 12159, // avg of last 3 months with payroll activity
  monthlyCriticalVendors: 0, // none classified yet — gate must be SKIPPED, not failed
  monthlyDebtService: 1500,
  locDrawn: 15000,
  locLimit: 35000,
  locAvailable: 20000,
}

const balanced: RiskMode = {
  modeKey: 'balanced',
  label: 'Balanced',
  description: '',
  isDefault: true,
  reserveFloorPct: 100,
  minDaysCash: 7,
  locAllowed: false,
  maxLocUtilizationPct: 0,
  minPayrollCoverageMonths: 1.5,
  minVendorCoverageMonths: 1.5,
  minDebtCoverageMonths: 1.5,
}

const conservative: RiskMode = {
  ...balanced,
  modeKey: 'conservative',
  label: 'Conservative',
  isDefault: false,
  minDaysCash: 10,
  minPayrollCoverageMonths: 2,
  minVendorCoverageMonths: 2,
  minDebtCoverageMonths: 2,
}

const aggressive: RiskMode = {
  ...balanced,
  modeKey: 'aggressive',
  label: 'Aggressive',
  isDefault: false,
  reserveFloorPct: 60,
  minDaysCash: 5,
  locAllowed: true,
  maxLocUtilizationPct: 50,
  minPayrollCoverageMonths: 1,
  minVendorCoverageMonths: 1,
  minDebtCoverageMonths: 1,
}

const recurring = (n: number) => ({ recurringMonthly: n, oneTime: 0 })
const oneTime = (n: number) => ({ recurringMonthly: 0, oneTime: n })

/* ------------------------------------------------------------------ */

console.log('\nProjection mechanics')
{
  const months = projectMonths(BASE, NO_COMMITMENT)
  check('projects exactly the horizon', months.length, 6)
  check('first month is the start month', months[0].monthKey, '2026-08')
  check('month keys roll over the year correctly', months[5].monthKey, '2027-01')
  checkNear('month 1 closes at cash + net flow', months[0].closingCash, 26617)
  checkNear('month 6 compounds the monthly surplus', months[5].closingCash, 61632)

  // Receivables are collected ONCE. Crediting them every month would manufacture
  // cash that does not exist.
  const withAr = projectMonths({ ...BASE, expectedReceivables: 5000 }, NO_COMMITMENT)
  checkNear('receivables land in month 1', withAr[0].closingCash, 31617)
  checkNear(
    'receivables are not credited again in month 2',
    withAr[1].closingCash - withAr[0].closingCash,
    7003,
  )

  // A one-time cost hits once; a recurring cost hits every month.
  const once = projectMonths(BASE, oneTime(5000))
  checkNear('one-time cost hits month 1 only', once[0].commitmentCost, 5000)
  check('one-time cost is absent in month 2', once[1].commitmentCost, 0)
  const rec = projectMonths(BASE, recurring(1200))
  checkNear('recurring cost charges every month', rec[5].commitmentCost, 1200)

  // Seasonality shapes revenue, not rent.
  const seasonal = projectMonths(
    { ...BASE, seasonalIndex: [0.5, 1, 1, 1, 1, 1] },
    NO_COMMITMENT,
  )
  checkNear('a slow month reduces inflow only', seasonal[0].inflow, 58901 * 0.5)
  checkNear('a slow month leaves outflow unchanged', seasonal[0].outflow, 51898)
}

console.log('\nDoing nothing must be affordable (threshold sanity)')
{
  // If committing to NOTHING fails, the thresholds are wrong and every answer the
  // planner gives is worthless. This guards the calibration directly.
  for (const [name, mode] of [
    ['Balanced', balanced],
    ['Conservative', conservative],
    ['Aggressive', aggressive],
  ] as const) {
    const r = evaluateRung(BASE, NO_COMMITMENT, mode, COV)
    check(`${name}: committing to nothing is supported`, r.classification !== 'Not Supported', true)
    check(`${name}: no failures with no commitment`, r.failures, [])
  }
}

console.log('\nAssessed on the LOWEST month, not the last one')
{
  // Declining cash: the horizon ends lower than it starts, so the low point is the
  // final month. A plan that survives month 1 but not month 6 is not affordable.
  const declining = { ...BASE, expectedInflow: 50000, expectedOutflow: 51898 }
  const r = evaluateRung(declining, recurring(1000), balanced, COV)
  check('low point is the last month when cash declines', r.lowestMonthKey, '2027-01')

  // Rising cash: the low point is month 1.
  const r2 = evaluateRung(BASE, NO_COMMITMENT, balanced, COV)
  check('low point is month 1 when cash rises', r2.lowestMonthKey, '2026-08')

  // A dip in the MIDDLE must be caught, not averaged away.
  const dip = { ...BASE, seasonalIndex: [1, 1, 0.2, 1, 1, 1] }
  const r3 = evaluateRung(dip, NO_COMMITMENT, balanced, COV)
  check('a mid-horizon dip becomes the low point', r3.lowestMonthKey, '2026-10')
}

console.log('\nSpec case: $1,200/month marketing agency')
{
  const r = evaluateRung(BASE, recurring(1200), balanced, COV)
  checkNear('low point', r.lowestProjectedCash, 25417)
  checkNear('reserve remaining', r.reserveRemaining, 10417)
  check('supported under Balanced', r.classification, 'Very Safe')
  check('no borrowing required', r.locRequired, 0)
  check('reserve is not compressed', r.reserveCompressed, false)
}

console.log('\nSpec case: $2,000/month advertising increase')
{
  const r = evaluateRung(BASE, recurring(2000), balanced, COV)
  checkNear('low point', r.lowestProjectedCash, 24617)
  check('supported under Balanced', r.classification !== 'Not Supported', true)
}

console.log('\nSpec case: $12,000 equipment, $3,000 down + $450/month')
{
  const r = evaluateRung(BASE, { recurringMonthly: 450, oneTime: 3000 }, balanced, COV)
  checkNear('low point absorbs the deposit in month 1', r.lowestProjectedCash, 23167)
  check('supported under Balanced', r.classification !== 'Not Supported', true)

  // Paying the full $12,000 in cash is a different question from financing it.
  const cash = evaluateRung(BASE, oneTime(12000), balanced, COV)
  checkNear('paying cash instead dips further', cash.lowestProjectedCash, 14617)
  check(
    'paying the full amount in cash breaches the Balanced reserve',
    cash.classification,
    'Not Supported',
  )
  checkTrue(
    'and says the reserve is the reason',
    cash.failures.some((f) => /reserve floor/i.test(f)),
  )
}

console.log('\nSpec case: employee at $15/hr x 40hr (full employer cost)')
{
  // Wage alone is $2,600/mo. Employer taxes and insurance make the real cost
  // higher — assuming wage = cost is exactly the error the spec warns about.
  const wageOnly = 15 * 40 * 52 / 12
  const fullCost = wageOnly * 1.15
  checkNear('wage-only figure', wageOnly, 2600)
  checkNear('full employer cost is materially higher', fullCost, 2990)

  const r = evaluateRung(BASE, recurring(fullCost), balanced, COV)
  check('supported under Balanced', r.classification !== 'Not Supported', true)
  checkNear('low point uses the full cost, not the wage', r.lowestProjectedCash, 23627)
}

console.log('\nSpec case: $5,000 inventory purchase (one-time)')
{
  const r = evaluateRung(BASE, oneTime(5000), balanced, COV)
  checkNear('low point', r.lowestProjectedCash, 21617)
  check('classified on cushion above the reserve', r.classification, 'Comfortable')
}

console.log('\nScenario stress')
{
  const commitment = recurring(1200)
  const matrix = buildScenarioMatrix(BASE, commitment, balanced, COV)

  const byKey = (k: string) => matrix.find((m) => m.key === k)!
  check('base scenario is present', byKey('base').label, 'Base')

  // 10% sales decline: survivable but visibly thinner.
  const down10 = byKey('sales_down_10')
  checkNear('10% sales decline low point', down10.lowestProjectedCash, 19092)
  check('10% decline still holds the reserve', down10.reserveRemaining > 0, true)

  // 15% decline breaks it — and must say so.
  const down15 = byKey('sales_down_15')
  check('15% decline is not supported', down15.classification, 'Not Supported')

  // Cost overrun alone.
  const cost = byKey('cost_overrun_10')
  check('10% cost overrun is evaluated', cost.outflowMultiplier, 1.1)

  // Combined stress is strictly worse than either alone.
  const combined = byKey('combined_stress')
  check(
    'combined stress is worse than a 10% sales drop alone',
    combined.lowestProjectedCash < down10.lowestProjectedCash,
    true,
  )
  check('combined stress is not supported', combined.classification, 'Not Supported')

  // Growth improves the picture.
  const growth = byKey('growth')
  check(
    'growth scenario improves the low point',
    growth.lowestProjectedCash > byKey('base').lowestProjectedCash,
    true,
  )

  // A custom decline the owner actually fears.
  const custom = buildScenarioMatrix(BASE, commitment, balanced, COV, {
    customSalesDeclinePct: 12,
  })
  checkTrue(
    'a custom decline is added',
    custom.some((s) => s.label === 'Sales down 12%'),
  )
}

console.log('\nRisk modes behave differently on the same commitment')
{
  const commitment = oneTime(12000)
  const b = evaluateRung(BASE, commitment, balanced, COV)
  const a = evaluateRung(BASE, commitment, aggressive, COV)

  check('Balanced refuses to spend into the reserve', b.classification, 'Not Supported')
  check('Aggressive permits it', a.classification !== 'Not Supported', true)
  checkNear('Aggressive floor is 60% of target', a.reserveFloor, 9000)
  check('Aggressive flags the compression as a tradeoff', a.reserveCompressed, true)
  checkTrue(
    'and explains the thinner cushion in words',
    a.tradeoffs.some((t) => /reserve/i.test(t)),
  )

  // Conservative is strictly the tightest of the three.
  const amounts = [1000, 3000, 5000, 8000]
  for (const amt of amounts) {
    const c = evaluateRung(BASE, oneTime(amt), conservative, COV)
    const bb = evaluateRung(BASE, oneTime(amt), balanced, COV)
    check(
      `Conservative is never more permissive than Balanced at $${amt}`,
      !(c.classification !== 'Not Supported' && bb.classification === 'Not Supported'),
      true,
    )
  }
}

console.log('\nBorrowing gates')
{
  // Big enough to go negative: $40,000 one-time against $26,617 of headroom.
  const big = oneTime(40000)

  const b = evaluateRung(BASE, big, balanced, COV)
  check('Balanced will not borrow at all', b.classification, 'Not Supported')
  checkTrue(
    'and says borrowing is why',
    b.failures.some((f) => /does not borrow/i.test(f)),
  )
  checkNear('shortfall is quantified', b.locRequired, 13383)

  // Aggressive allows borrowing but caps utilization at 50%.
  const a = evaluateRung(BASE, big, aggressive, COV)
  checkTrue(
    'Aggressive refuses because utilization would exceed its cap',
    a.failures.some((f) => /credit line at/i.test(f)),
  )

  // Not enough credit available at all.
  const broke: CoverageInputs = { ...COV, locAvailable: 1000 }
  const noCredit = evaluateRung(BASE, big, aggressive, broke)
  checkTrue(
    'reports insufficient available credit',
    noCredit.failures.some((f) => /only \$1,000 of credit is available/i.test(f)),
  )
}

console.log('\nCoverage gates skip costs that are not on file')
{
  // Critical vendor spend is 0 in COV. A gate cannot be judged against a cost that
  // does not exist, so it must be SKIPPED — never failed, and never treated as 0
  // months of coverage.
  const r = evaluateRung(BASE, NO_COMMITMENT, balanced, COV)
  check('vendor coverage is null, not zero', r.vendorCoverageMonths, null)
  checkTrue(
    'no vendor failure is raised',
    !r.failures.some((f) => /vendor/i.test(f)),
  )
  check('payroll coverage is a real number', typeof r.payrollCoverageMonths, 'number')

  // With payroll on file and a huge commitment, the payroll gate must bite.
  const tight = evaluateRung(BASE, oneTime(15000), aggressive, COV)
  checkTrue(
    'payroll coverage failure is raised when cash gets thin',
    tight.failures.some((f) => /payroll/i.test(f)),
  )
}

console.log('\nLadder')
{
  const ladder = buildCapacityLadder(BASE, balanced, COV)
  check(
    'covers every default rung',
    ladder.length,
    RECURRING_RUNGS.length + ONE_TIME_RUNGS.length,
  )
  check('recurring rungs come first', ladder[0].kind, 'recurring')
  check('smallest recurring rung first', ladder[0].amount, 250)

  // Larger commitments can never be safer than smaller ones.
  const rec = ladder.filter((r) => r.kind === 'recurring')
  for (let i = 1; i < rec.length; i++) {
    check(
      `$${rec[i].amount}/mo leaves no more cash than $${rec[i - 1].amount}/mo`,
      rec[i].lowestProjectedCash <= rec[i - 1].lowestProjectedCash,
      true,
    )
  }

  const custom = buildCapacityLadder(BASE, balanced, COV, {
    customRecurring: 1750,
    customOneTime: 6250,
  })
  checkTrue(
    'a custom recurring amount is included and flagged',
    custom.some((r) => r.kind === 'recurring' && r.amount === 1750 && r.isCustom),
  )
  checkTrue(
    'a custom one-time amount is included and flagged',
    custom.some((r) => r.kind === 'one-time' && r.amount === 6250 && r.isCustom),
  )
}

console.log('\nMaximum supported amount')
{
  const maxRec = maxSupported(BASE, balanced, COV, 'recurring')
  const maxOne = maxSupported(BASE, balanced, COV, 'one-time')
  check('a recurring maximum is found', maxRec > 0, true)
  check('a one-time maximum is found', maxOne > 0, true)

  // The boundary must be real: at the maximum it passes, a dollar more fails.
  const at = evaluateRung(BASE, recurring(maxRec), balanced, COV)
  const over = evaluateRung(BASE, recurring(maxRec + 50), balanced, COV)
  check('the maximum itself is supported', at.classification !== 'Not Supported', true)
  check('just above the maximum is not', over.classification, 'Not Supported')

  // Aggressive must allow at least as much as Balanced.
  check(
    'Aggressive supports at least as much as Balanced',
    maxSupported(BASE, aggressive, COV, 'one-time') >= maxOne,
    true,
  )

  // When nothing is affordable the answer is 0, not a misleading small number.
  const broke: ProjectionAssumptions = { ...BASE, cashOnHand: 500, expectedInflow: 10000, expectedOutflow: 51898 }
  check('returns 0 when nothing is affordable', maxSupported(broke, balanced, COV, 'recurring'), 0)
}

console.log('\nStrategy is separate from affordability')
{
  const weak = assessStrategicTiming({
    startMonthKey: '2026-08',
    horizonMonths: 6,
    seasonalIndex: [0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
    revenueTrendPct: -5,
  })
  check('a weak season is rated Weak', weak.rating, 'Weak')
  checkTrue('weak months are named', weak.weakMonths.length > 0)
  checkTrue(
    'and it says plainly that affordability is judged separately',
    /affordability is judged separately/i.test(weak.detail),
  )

  const strong = assessStrategicTiming({
    startMonthKey: '2026-08',
    horizonMonths: 6,
    seasonalIndex: [1.2, 1.15, 1.1, 1.05, 1.1, 1.15],
    revenueTrendPct: 8,
  })
  check('a strong season is rated Strong', strong.rating, 'Strong')

  // The decisive property: seasonality must NOT change affordability. Same
  // commitment, same cash, different season — identical verdict.
  const flat = evaluateRung(BASE, recurring(1200), balanced, COV)
  const seasonalBase: ProjectionAssumptions = {
    ...BASE,
    seasonalIndex: [1, 1, 1, 1, 1, 1],
  }
  const same = evaluateRung(seasonalBase, recurring(1200), balanced, COV)
  check(
    'an average-index season matches no index at all',
    same.classification,
    flat.classification,
  )
  checkNear('and produces the same low point', same.lowestProjectedCash, flat.lowestProjectedCash)
}

console.log('\nNo silent zeros')
{
  // A zero outflow rate must not manufacture infinite days of cash.
  const noOutflow: CoverageInputs = { ...COV, avgDailyOutflow: 0 }
  const r = evaluateRung(BASE, NO_COMMITMENT, balanced, noOutflow)
  check('days-of-cash gate is skipped when the rate is unknown', r.daysOfCash, 0)
  checkTrue(
    'and no days-of-cash failure is invented',
    !r.failures.some((f) => /days of cash/i.test(f)),
  )

  // A zero reserve target must not crash the cushion ratio.
  const noReserve: CoverageInputs = { ...COV, minCashReserve: 0 }
  const r2 = evaluateRung(BASE, NO_COMMITMENT, balanced, noReserve)
  check('a zero reserve target still classifies', r2.classification !== 'Not Supported', true)
}

console.log('\nCoverage gates must not override the owner-set reserve')
{
  // REGRESSION. The seeded 1.5-month payroll minimum required $18,030 of low-point
  // cash against an owner-set $15,000 reserve floor, making the payroll gate strictly
  // tighter than the reserve. It became the binding constraint on every rung and
  // failed even the do-nothing baseline, so the page told the owner nothing -- and it
  // silently substituted our judgment for their own cushion setting.
  const payroll = 12020
  const reserve = 15000

  const overriding = { ...balanced, minPayrollCoverageMonths: 1.5 }
  const needed = payroll * overriding.minPayrollCoverageMonths
  checkTrue(
    'a 1.5-month payroll gate would demand more cash than the reserve floor',
    needed > reserve,
  )

  const calibrated = { ...balanced, minPayrollCoverageMonths: 1.0 }
  checkTrue(
    'the calibrated 1-month gate sits below the reserve floor',
    payroll * calibrated.minPayrollCoverageMonths < reserve,
  )

  // With cash exactly at the reserve floor, the reserve is satisfied, so the payroll
  // gate must not be what fails the rung.
  const atFloor: CoverageInputs = {
    ...COV,
    minCashReserve: reserve,
    monthlyPayroll: payroll,
  }
  const base = { ...BASE, cashOnHand: reserve, expectedInflow: 0, expectedOutflow: 0 }
  const r = evaluateRung(base, NO_COMMITMENT, calibrated, atFloor)
  checkTrue(
    'doing nothing at the reserve floor raises no payroll failure',
    !r.failures.some((f) => /payroll/i.test(f)),
  )

  // The gate must still fire when payroll genuinely outgrows the reserve.
  const bigPayroll: CoverageInputs = { ...atFloor, monthlyPayroll: 20000 }
  const r2 = evaluateRung(base, NO_COMMITMENT, calibrated, bigPayroll)
  checkTrue(
    'but still fires once one month of payroll exceeds the reserve',
    r2.failures.some((f) => /payroll/i.test(f)),
  )
}

console.log('\nA planner that fails its own baseline is useless')
{
  // Whatever the thresholds, committing to NOTHING must be achievable whenever the
  // projection stays at or above the reserve floor. If the baseline itself fails, no
  // rung can pass and the whole ladder is noise.
  const steady: CoverageInputs = {
    ...COV,
    minCashReserve: 15000,
    monthlyPayroll: 12020,
    monthlyDebtService: 2000,
  }
  const base = { ...BASE, cashOnHand: 19614, expectedInflow: 0, expectedOutflow: 0 }
  const r = evaluateRung(base, NO_COMMITMENT, balanced, steady)
  checkTrue(
    'the do-nothing baseline passes when cash stays above the floor',
    r.classification !== 'Not Supported',
  )
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
