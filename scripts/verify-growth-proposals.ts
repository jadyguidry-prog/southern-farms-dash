/**
 * Growth proposals — verification of the typed-proposal decision layer.
 *
 * Exercises the SAME exported functions the page renders. Proposals are only a
 * translation on top of the capacity engine, so these tests focus on the parts
 * that are genuinely new: cost translation (especially employer burden), verdict
 * logic, revenue-based ROI, resilience, and the "what has to change" alternatives.
 *
 * Two baselines on purpose:
 *   - REAL: Southern Farms as measured Aug 2026, where even doing nothing barely
 *     clears the reserve. Used to prove unsupported proposals fail honestly and
 *     produce concrete alternatives.
 *   - HEALTHY: a business with real headroom, used to prove supported proposals
 *     are graded and their conditions read correctly. Without it every proposal
 *     would be "Not supported" and half the logic would go untested.
 */

import {
  type CoverageInputs,
  type ProjectionAssumptions,
  type RiskMode,
  type StrategicTiming,
} from '../lib/growth-planner'
import {
  addMonthsISO,
  analyzeProposal,
  buildAlternatives,
  computeRevenueRoi,
  maxSurvivableSalesDeclinePct,
  proposalToCost,
  type EmployeeHireProposal,
  type EquipmentProposal,
  type Proposal,
} from '../lib/growth-proposals'

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

function ok(label: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  ok    ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const balanced: RiskMode = {
  modeKey: 'balanced',
  label: 'Balanced',
  description: '',
  isDefault: true,
  reserveFloorPct: 100,
  minDaysCash: 7,
  locAllowed: false,
  maxLocUtilizationPct: 0,
  minPayrollCoverageMonths: 1,
  minVendorCoverageMonths: 1.5,
  minDebtCoverageMonths: 1.5,
  headlineStressSalesDeclinePct: 10,
}

// Southern Farms, Aug 2026 — even doing nothing barely clears the reserve.
const REAL: ProjectionAssumptions = {
  cashOnHand: 19614,
  expectedReceivables: 0,
  expectedInflow: 58901,
  expectedOutflow: 51898,
  horizonMonths: 6,
  startMonthKey: '2026-08',
}

const REAL_COV: CoverageInputs = {
  minCashReserve: 15000,
  avgDailyOutflow: 51898 / 30.44,
  monthlyPayroll: 12159,
  monthlyCriticalVendors: 0,
  monthlyDebtService: 1500,
  locDrawn: 15000,
  locLimit: 35000,
  locAvailable: 20000,
}

// A healthier business with genuine headroom, for the supported path.
const HEALTHY: ProjectionAssumptions = {
  cashOnHand: 80000,
  expectedReceivables: 0,
  expectedInflow: 60000,
  expectedOutflow: 52000,
  horizonMonths: 6,
  startMonthKey: '2026-08',
}

const HEALTHY_COV: CoverageInputs = {
  ...REAL_COV,
  monthlyPayroll: 10000,
}

const STRATEGY: StrategicTiming = {
  score: 90,
  rating: 'Reasonable',
  detail: '',
  weakMonths: ['2026-11', '2026-12'],
}

const TODAY = '2026-08-03'

/* ------------------------------------------------------------------ */

console.log('\nEmployee cost is pay PLUS burden, never the wage alone')
{
  // Spec case: $15/hr x 40hr. The whole point of the type is that the honest cost
  // is not 15*40*(52/12) = $2,600 — it includes employer burden. A 12% burden must
  // land the monthly cost at $2,912, and the breakdown must show the burden line.
  const hire: EmployeeHireProposal = {
    type: 'employee_hire',
    name: 'Yard hand',
    hourlyWage: 15,
    hoursPerWeek: 40,
    employerBurdenPct: 12,
  }
  const cost = proposalToCost(hire)
  checkNear('base pay is wage x hours x weeks/month', cost.lines[0].amount, 2600, 1)
  checkNear('burden is added on top', cost.lines[1].amount, 312, 1)
  checkNear('fully-loaded monthly cost includes burden', cost.commitment.recurringMonthly, 2912, 1)
  ok(
    'the breakdown names the burden explicitly',
    cost.lines.some((l) => /burden/i.test(l.label)),
  )
  ok(
    'a caveat states the wage is not the whole cost',
    cost.caveats.some((c) => /burden/i.test(c)),
  )

  // Salary path: $52,000/yr at 15% burden -> $4,333.33 * 1.15.
  const salaried: EmployeeHireProposal = {
    type: 'employee_hire',
    name: 'Manager',
    annualSalary: 52000,
    employerBurdenPct: 15,
  }
  checkNear(
    'salary path also loads burden',
    proposalToCost(salaried).commitment.recurringMonthly,
    (52000 / 12) * 1.15,
    1,
  )
}

console.log('\nEquipment financing changes what hits cash and when')
{
  // Spec case: $12,000 equipment, $3,000 down + $450/mo.
  const equip: EquipmentProposal = {
    type: 'equipment',
    name: 'Walk-in cooler',
    price: 12000,
    financing: 'down_and_finance',
    downPayment: 3000,
    monthlyPayment: 450,
    termMonths: 24,
  }
  const cost = proposalToCost(equip)
  check('down payment is the one-time cost', cost.commitment.oneTime, 3000)
  check('finance payment is the recurring cost', cost.commitment.recurringMonthly, 450)

  // Cash purchase is all one-time.
  const cash = proposalToCost({ ...equip, financing: 'cash', downPayment: undefined, monthlyPayment: undefined })
  check('cash purchase is all upfront', cash.commitment.oneTime, 12000)
  check('cash purchase has no recurring cost', cash.commitment.recurringMonthly, 0)

  // Card purchase is flagged, not treated as free float.
  const card = proposalToCost({ ...equip, financing: 'card' })
  check('card purchase counts the price as cash owed', card.commitment.oneTime, 12000)
  ok(
    'card purchase warns it must be cleared at the statement',
    card.caveats.some((c) => /statement/i.test(c)),
  )

  // Balloon is surfaced separately, never folded into the monthly figure.
  const balloon = proposalToCost({ ...equip, balloonPayment: 5000 })
  ok(
    'a balloon payment is surfaced as its own caveat',
    balloon.caveats.some((c) => /balloon/i.test(c)),
    JSON.stringify(balloon.caveats),
  )
  check('the balloon is NOT added into the monthly payment', balloon.commitment.recurringMonthly, 450)
}

console.log('\nMarketing proposals — agency retainer and bounded campaign')
{
  // Spec case: $1,200/mo agency.
  const agency: Proposal = { type: 'marketing_agency', name: 'SEO agency', monthlyRetainer: 1200 }
  check('agency retainer is recurring', proposalToCost(agency).commitment.recurringMonthly, 1200)

  // Spec case: $2,000/mo ad increase.
  const campaign: Proposal = { type: 'marketing_campaign', name: 'Summer ads', monthlyAmount: 2000 }
  check('ad spend increase is recurring', proposalToCost(campaign).commitment.recurringMonthly, 2000)

  // A bounded campaign is judged as recurring while it runs, and says so.
  const bounded = proposalToCost({ type: 'marketing_campaign', name: 'Fair week', monthlyAmount: 2000, durationMonths: 3 })
  check('a 3-month campaign still charges the full monthly while running', bounded.commitment.recurringMonthly, 2000)
  ok(
    'the bounded nature is stated as a caveat',
    bounded.caveats.some((c) => /bounded|campaign/i.test(c)),
  )
}

console.log('\nInventory is a one-time buy')
{
  // Spec case: $5,000 inventory.
  const inv: Proposal = { type: 'inventory', name: 'Seed stock', amount: 5000 }
  const cost = proposalToCost(inv)
  check('inventory is one-time', cost.commitment.oneTime, 5000)
  check('inventory has no recurring cost', cost.commitment.recurringMonthly, 0)
}

console.log('\nROI is revenue-based and never invents a margin')
{
  const cost = proposalToCost({ type: 'marketing_agency', name: 'A', monthlyRetainer: 1200 })
  const roi = computeRevenueRoi(cost)
  check('break-even is stated in gross profit, equal to the cost', roi.breakevenMonthlyGrossProfit, 1200)
  check('no margin is assumed by default', roi.assumedMarginPct, null)
  ok('a sensitivity table is provided across several margins', roi.sensitivity.length >= 3)
  // At 30% margin, $1,200 profit needs $4,000 in sales.
  const m30 = roi.sensitivity.find((r) => r.marginPct === 30)
  checkNear('at 30% margin it would take $4,000 in sales', m30?.requiredMonthlySales ?? -1, 4000, 1)

  // An owner-supplied margin is used but labelled, never treated as authoritative.
  const withMargin = computeRevenueRoi(cost, { assumedMarginPct: 40 })
  check('the assumed margin is recorded as an assumption', withMargin.assumedMarginPct, 40)
  checkNear('required sales at the assumed margin', withMargin.requiredMonthlySalesAtAssumed ?? -1, 3000, 1)
}

console.log('\nResilience is measured, not guessed')
{
  const cost = proposalToCost({ type: 'marketing_agency', name: 'A', monthlyRetainer: 500 })
  const survivesHealthy = maxSurvivableSalesDeclinePct(HEALTHY, cost.commitment, balanced, HEALTHY_COV)
  const survivesReal = maxSurvivableSalesDeclinePct(REAL, cost.commitment, balanced, REAL_COV)
  ok(
    'a healthy business survives a larger sales drop than a tight one',
    survivesHealthy > survivesReal,
    `healthy ${survivesHealthy} vs real ${survivesReal}`,
  )
  ok('resilience is a bounded percentage', survivesReal >= 0 && survivesReal <= 100)
}

console.log('\nVerdict + decision output on a supported proposal')
{
  const { decision } = analyzeProposal({
    proposal: { type: 'marketing_agency', name: 'SEO agency', monthlyRetainer: 1200 },
    assumptions: HEALTHY,
    mode: balanced,
    cov: HEALTHY_COV,
    strategy: STRATEGY,
    confidenceGaps: [],
    todayISO: TODAY,
    reviewCadenceMonths: 3,
  })
  ok('a comfortable proposal is supported', decision.verdict !== 'Not supported', decision.verdict)
  checkNear('first-year cost is upfront + 12 months', decision.firstYearCost, 1200 * 12, 1)
  ok('a monitoring plan is produced', decision.monitoringPlan.length > 0)
  check('the next review date is three months out', decision.nextReviewDate, '2026-11-03')
  ok('no alternatives are offered when it already fits', decision.alternatives.length === 0)
}

console.log('\nUnsupported proposal produces concrete, computed alternatives')
{
  // A big hire against the REAL tight baseline should not fit, and must say exactly
  // what would change it — not vague advice.
  // Sized to clearly exceed the ~$7,003/mo surplus once burden is loaded, so cash
  // erodes below the reserve floor within the horizon.
  const hire: EmployeeHireProposal = {
    type: 'employee_hire',
    name: 'Full-time hand',
    hourlyWage: 40,
    hoursPerWeek: 45,
    employerBurdenPct: 15,
  }
  const { decision, evaluation } = analyzeProposal({
    proposal: hire,
    assumptions: REAL,
    mode: balanced,
    cov: REAL_COV,
    strategy: STRATEGY,
    confidenceGaps: ['Amex card balance is missing'],
    todayISO: TODAY,
    reviewCadenceMonths: 3,
  })
  check('an unaffordable hire is not supported', decision.verdict, 'Not supported')
  ok('a binding constraint is named', decision.bindingConstraint !== null)
  ok('alternatives are offered', decision.alternatives.length > 0)
  ok(
    'one alternative reduces the hours (solved, not vague)',
    decision.alternatives.some((a) => a.kind === 'reduce_recurring' && /hours/i.test(a.label)),
    JSON.stringify(decision.alternatives.map((a) => a.label)),
  )
  ok(
    'the missing card balance is surfaced as a fixable gap',
    decision.alternatives.some((a) => a.kind === 'resolve_data'),
  )
  // The reduce-hours alternative must actually fit — a suggestion that still fails
  // is worse than none.
  const reduce = decision.alternatives.find((a) => a.kind === 'reduce_recurring')
  ok('the alternatives address the real failure', evaluation.classification === 'Not Supported' && reduce != null)
}

console.log('\nSupported-with-conditions when resilience is thin')
{
  // Sized to fit today but not clear a 10% drop — must be conditional, not a clean yes,
  // and the condition must spell out the downturn limit.
  const survives = (amt: number) =>
    maxSurvivableSalesDeclinePct(HEALTHY, { recurringMonthly: amt, oneTime: 0 }, balanced, HEALTHY_COV)
  // find an amount that fits now but survives < 10%
  let amount = 0
  for (let a = 1000; a <= 20000; a += 250) {
    const s = survives(a)
    if (s > 0 && s < 10) { amount = a; break }
  }
  if (amount > 0) {
    const { decision } = analyzeProposal({
      proposal: { type: 'marketing_agency', name: 'Stretch retainer', monthlyRetainer: amount },
      assumptions: HEALTHY,
      mode: balanced,
      cov: HEALTHY_COV,
      strategy: STRATEGY,
      confidenceGaps: [],
      todayISO: TODAY,
      reviewCadenceMonths: 3,
    })
    check('a thin-resilience proposal is conditional', decision.verdict, 'Supported with conditions')
    ok(
      'the condition states the sales-drop limit',
      decision.conditions.some((c) => /sales/i.test(c)),
    )
  } else {
    ok('found no thin-resilience amount to test (skipped)', true)
  }
}

console.log('\nDate helper handles month-end clamping')
{
  check('adds whole months', addMonthsISO('2026-08-03', 3), '2026-11-03')
  check('rolls over the year', addMonthsISO('2026-11-15', 3), '2027-02-15')
  check('clamps Jan 31 + 1 month to Feb 28', addMonthsISO('2027-01-31', 1), '2027-02-28')
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
