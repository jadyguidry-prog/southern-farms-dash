/**
 * Growth outcomes — verification of the forecast-vs-actual comparison layer.
 *
 * Exercises the SAME exported `summarizeOutcomes` the pages render. The tests are
 * deliberately weighted toward the ways this could flatter the numbers, because
 * that is the failure mode that matters in a tool used to judge spending:
 *
 *   - an unrecorded month must not count as a $0 month
 *   - forecast must be summed over recorded months only
 *   - recorded SALES must never be compared against the gross-PROFIT break-even
 *   - weakly attributed revenue must not roll into an "it earned this" total
 */

import {
  type Attribution,
  type OutcomeRecord,
  summarizeOutcomes,
} from '../lib/growth-outcomes'
import { addMonths, monthsBetween } from '../lib/month-key'

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
// A marketing retainer: $800/mo forecast, no upfront. Break-even in gross profit is
// $800, which at the standard sensitivity margins implies these required SALES.
const SENSITIVITY = [
  { marginPct: 20, requiredMonthlySales: 4000 },
  { marginPct: 30, requiredMonthlySales: 2667 },
  { marginPct: 40, requiredMonthlySales: 2000 },
  { marginPct: 50, requiredMonthlySales: 1600 },
]

function outcome(
  monthKey: string,
  actualCost: number | null,
  revenueImpact: number | null = null,
  attribution: Attribution = 'not_measurable',
): OutcomeRecord {
  return { monthKey, actualCost, revenueImpact, attribution, notes: null }
}

const base = {
  forecastMonthlyCost: 800,
  forecastUpfrontCost: 0,
  sensitivity: SENSITIVITY,
  todayMonthKey: '2026-08',
}

console.log('Not activated')
{
  const s = summarizeOutcomes({ ...base, activation: null, outcomes: [] })
  check('verdict is not_activated', s.verdict, 'not_activated')
  check('no months invented', s.months.length, 0)
  check('actual cost is null, not 0', s.actualCostOverRecorded, null)
  ok('headline asks for the start month', /record the month it began/i.test(s.headline))
}

console.log('\nActivated but nothing recorded')
{
  const s = summarizeOutcomes({
    ...base,
    activation: { actualStartDate: '2026-05-10', actualUpfrontCost: 0, notes: null },
    outcomes: [],
  })
  check('4 months elapsed May..Aug inclusive', s.monthsElapsed, 4)
  check('none recorded', s.monthsRecorded, 0)
  check('verdict is no_months_recorded', s.verdict, 'no_months_recorded')
  // The central honesty rule: silence is not a zero.
  check('actual cost stays null rather than 0', s.actualCostOverRecorded, null)
  check('cost variance stays null', s.costVariance, null)
  check('all 4 months listed as missing', s.monthsMissing.length, 4)
  ok('every month row is unrecorded', s.months.every((m) => !m.recorded))
  ok('every actual cost is null', s.months.every((m) => m.actualCost === null))
}

console.log('\nForecast is summed over RECORDED months only')
{
  // Live 4 months, but only 2 logged at exactly forecast. If the forecast were summed
  // over all 4 elapsed months ($3,200) against $1,600 of actuals, this would look 50%
  // under budget when it is actually exactly on budget.
  const s = summarizeOutcomes({
    ...base,
    activation: { actualStartDate: '2026-05-01', actualUpfrontCost: 0, notes: null },
    outcomes: [outcome('2026-05', 800), outcome('2026-06', 800)],
  })
  check('2 of 4 months recorded', s.monthsRecorded, 2)
  check('forecast covers recorded months only', s.forecastCostOverRecorded, 1600)
  check('actual matches', s.actualCostOverRecorded, 1600)
  check('variance is zero, not negative', s.costVariance, 0)
  check('variance pct is zero', s.costVariancePct, 0)
  ok('headline says exactly as forecast', /exactly what was forecast/i.test(s.headline))
  check('2 months still flagged missing', s.monthsMissing, ['2026-07', '2026-08'])
}

console.log('\nOver and under budget')
{
  const over = summarizeOutcomes({
    ...base,
    activation: { actualStartDate: '2026-07-01', actualUpfrontCost: 0, notes: null },
    outcomes: [outcome('2026-07', 1000), outcome('2026-08', 1000)],
  })
  check('over-budget variance', over.costVariance, 400)
  check('over-budget pct', over.costVariancePct, 25)
  ok('headline says more than forecast', /25% more than forecast/i.test(over.headline))

  const under = summarizeOutcomes({
    ...base,
    activation: { actualStartDate: '2026-07-01', actualUpfrontCost: 0, notes: null },
    outcomes: [outcome('2026-07', 600), outcome('2026-08', 600)],
  })
  check('under-budget variance is negative', under.costVariance, -400)
  ok('headline says less than forecast', /25% less than forecast/i.test(under.headline))
}

console.log('\nUpfront cost variance is tracked separately')
{
  const s = summarizeOutcomes({
    ...base,
    forecastUpfrontCost: 2000,
    activation: { actualStartDate: '2026-07-01', actualUpfrontCost: 2750, notes: null },
    outcomes: [outcome('2026-07', 800)],
  })
  check('upfront overran by 750', s.upfrontVariance, 750)
  // A one-time overrun must not be smeared into the monthly comparison.
  check('monthly variance unaffected by upfront', s.costVariance, 0)
}

console.log('\nCost recorded, no revenue yet')
{
  const s = summarizeOutcomes({
    ...base,
    activation: { actualStartDate: '2026-07-01', actualUpfrontCost: 0, notes: null },
    outcomes: [outcome('2026-07', 800), outcome('2026-08', 800)],
  })
  check('verdict is cost_only', s.verdict, 'cost_only')
  check('no defensible revenue', s.defensibleRevenue, null)
  ok('headline admits payback is unknown', /still unknown/i.test(s.headline))
  check('no margin checks without revenue', s.marginChecks.length, 0)
}

console.log('\nSALES are never compared against the gross-PROFIT break-even')
{
  // $2,400/mo of attributed sales against an $800 profit break-even. Comparing the
  // two directly would read as 3x and "comfortably profitable". In truth $2,400 only
  // clears break-even at a 40%+ margin; at 20% or 30% it is still losing money.
  const s = summarizeOutcomes({
    ...base,
    activation: { actualStartDate: '2026-07-01', actualUpfrontCost: 0, notes: null },
    outcomes: [
      outcome('2026-07', 800, 2400, 'attributed'),
      outcome('2026-08', 800, 2400, 'attributed'),
    ],
  })
  check('avg attributed sales', s.avgMonthlyDefensibleRevenue, 2400)
  check('verdict is margin-dependent', s.verdict, 'covering_at_optimistic_margins')
  check('fails at 20% margin', s.marginChecks.find((m) => m.marginPct === 20)?.clears, false)
  check('fails at 30% margin', s.marginChecks.find((m) => m.marginPct === 30)?.clears, false)
  check('clears at 40% margin', s.marginChecks.find((m) => m.marginPct === 40)?.clears, true)
  ok('headline names the margin needed', /at least 40%/i.test(s.headline))
  ok('headline warns of a loss below that', /still running at a loss/i.test(s.headline))
}

console.log('\nClearly covering, and clearly not')
{
  const strong = summarizeOutcomes({
    ...base,
    activation: { actualStartDate: '2026-08-01', actualUpfrontCost: 0, notes: null },
    outcomes: [outcome('2026-08', 800, 5000, 'attributed')],
  })
  check('covers at every margin', strong.verdict, 'covering_at_all_margins')
  ok('headline cites the conservative margin', /most conservative margin/i.test(strong.headline))

  const weak = summarizeOutcomes({
    ...base,
    activation: { actualStartDate: '2026-08-01', actualUpfrontCost: 0, notes: null },
    outcomes: [outcome('2026-08', 800, 900, 'attributed')],
  })
  check('covers at no margin', weak.verdict, 'not_covering')
  ok('headline says it covers nothing', /do not cover its cost at any/i.test(weak.headline))
}

console.log('\nWeakly attributed revenue is not evidence')
{
  const s = summarizeOutcomes({
    ...base,
    activation: { actualStartDate: '2026-08-01', actualUpfrontCost: 0, notes: null },
    outcomes: [outcome('2026-08', 800, 9000, 'correlated_only')],
  })
  // $9,000 would clear every margin, but it is only correlated, so it must not be
  // reported as a return.
  check('verdict flags weak attribution', s.verdict, 'revenue_not_defensible')
  check('defensible revenue stays null', s.defensibleRevenue, null)
  check('weak revenue is reported separately', s.nonDefensibleRevenue, 9000)
  check('no margin checks from weak revenue', s.marginChecks.length, 0)
  ok('headline says it is not evidence', /not evidence/i.test(s.headline))
}

console.log('\nMixed attribution takes the weakest, and only counts defensible months')
{
  const s = summarizeOutcomes({
    ...base,
    activation: { actualStartDate: '2026-06-01', actualUpfrontCost: 0, notes: null },
    outcomes: [
      outcome('2026-06', 800, 3000, 'attributed'),
      outcome('2026-07', 800, 2000, 'partially_attributed'),
      outcome('2026-08', 800, 6000, 'correlated_only'),
    ],
  })
  check('defensible revenue excludes the correlated month', s.defensibleRevenue, 5000)
  check('averaged over 2 defensible months', s.avgMonthlyDefensibleRevenue, 2500)
  check('correlated revenue held separately', s.nonDefensibleRevenue, 6000)
  check('weakest attribution surfaces', s.weakestAttribution, 'correlated_only')
}

console.log('\nA future start date reads as not started')
{
  const s = summarizeOutcomes({
    ...base,
    activation: { actualStartDate: '2026-12-01', actualUpfrontCost: 0, notes: null },
    outcomes: [],
  })
  check('no negative month count', s.monthsElapsed, 0)
  check('no month rows', s.months.length, 0)
}

console.log('\nMonth helpers')
{
  check('monthsBetween forward', monthsBetween('2026-05', '2026-08'), 3)
  check('monthsBetween backward', monthsBetween('2026-08', '2026-05'), -3)
  check('monthsBetween across years', monthsBetween('2025-11', '2026-02'), 3)
  check('addMonths rolls the year', addMonths('2026-11', 3), '2027-02')
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
