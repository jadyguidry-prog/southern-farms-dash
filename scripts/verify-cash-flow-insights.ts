/**
 * Verification for the cash-flow advisor insights in lib/health.ts —
 *   npx tsx scripts/verify-cash-flow-insights.ts
 *
 * The advisor is the surface most likely to state something false with total
 * confidence, so these tests pin the rules that keep it honest: no cash-flow
 * insights at all when no transactions are imported, and no claim about a month
 * whose deposit account was never imported.
 */

import { generateInsights, type CashFlowInsightInput } from '../lib/health'
import type { BusinessSettings } from '../lib/queries'

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

/** Thresholds are irrelevant here; only the cash-flow branch is under test. */
const settings = {
  min_cash_reserve: 50000,
  target_payroll_pct: 25,
  warning_payroll_pct: 30,
  minimum_weekly_sales: 20000,
  preferred_weekly_sales: 30000,
} as unknown as BusinessSettings

/**
 * Pillars are forced to `unknown` so they emit nothing. That isolates the
 * cash-flow insights: any id starting `auto-cashflow-` is ours.
 */
const pillars = {
  payroll: { status: 'unknown', label: 'Unknown', message: '' },
  cash: { status: 'unknown', label: 'Unknown', message: '' },
  sales: { status: 'unknown', label: 'Unknown', message: '' },
} as never

function cashFlowIds(cashFlow?: CashFlowInsightInput): string[] {
  return generateInsights({ settings, pillars, cashFlow })
    .filter((i) => i.id.startsWith('auto-cashflow-'))
    .map((i) => i.id)
    .sort()
}

/* ---------------- absent data produces no claims ---------------- */
// The single most important rule: with nothing imported the advisor must stay
// silent rather than reporting a $0 month as a real result.
eq(cashFlowIds(undefined), [], 'insights: no cash-flow group means no insights')
eq(cashFlowIds({}), [], 'insights: empty group produces no insights')
eq(
  cashFlowIds({ latestCompleteMonth: null, topPayee: null }),
  [],
  'insights: explicit nulls produce no insights',
)

/* ---------------- monthly net ---------------- */
{
  const ids = cashFlowIds({
    latestCompleteMonth: {
      month: "Jun '26",
      inflow: 101960.9,
      outflow: 103837.35,
      net: -1876.45,
    },
  })
  eq(ids, ['auto-cashflow-negative'], 'insights: negative month warns')
}
{
  const ids = cashFlowIds({
    latestCompleteMonth: { month: "May '26", inflow: 120000, outflow: 90000, net: 30000 },
  })
  eq(ids, ['auto-cashflow-positive'], 'insights: positive month is an opportunity')
}

// A month is never described as both positive and negative.
{
  const all = cashFlowIds({
    latestCompleteMonth: { month: "Jun '26", inflow: 1, outflow: 2, net: -1 },
  })
  eq(
    all.includes('auto-cashflow-positive'),
    false,
    'insights: negative month is not also positive',
  )
}

/* ---------------- payee concentration ---------------- */
{
  const insights = generateInsights({
    settings,
    pillars,
    cashFlow: { topPayee: { payee: 'QUIRCHFOODS', amount: 98169.03, share: 0.147 } },
  })
  const top = insights.find((i) => i.id === 'auto-cashflow-top-payee')
  eq(top?.severity, 'opportunity', 'insights: 15% payee is an opportunity')
  eq(
    top?.title,
    'QUIRCHFOODS is 15% of identified spending',
    'insights: payee title states the real share',
  )
}
{
  const insights = generateInsights({
    settings,
    pillars,
    cashFlow: { topPayee: { payee: 'BIG SUPPLIER', amount: 400000, share: 0.6 } },
  })
  eq(
    insights.find((i) => i.id === 'auto-cashflow-top-payee')?.severity,
    'warning',
    'insights: dominant payee escalates to warning',
  )
}
// A small payee is not worth a concentration warning.
eq(
  cashFlowIds({ topPayee: { payee: 'SMALL', amount: 100, share: 0.02 } }),
  [],
  'insights: minor payee produces no concentration insight',
)

/* ---------------- unattributed spend ---------------- */
{
  const insights = generateInsights({
    settings,
    pillars,
    cashFlow: {
      unidentifiedOutflow: { amount: 300555.52, count: 231, share: 0.449 },
    },
  })
  const u = insights.find((i) => i.id === 'auto-cashflow-unidentified')
  eq(u?.severity, 'warning', 'insights: heavy unattributed spend warns')
  eq(
    u?.title,
    '45% of spending has no identifiable payee',
    'insights: unattributed title states the real share',
  )
}
eq(
  cashFlowIds({ unidentifiedOutflow: { amount: 10, count: 1, share: 0.01 } }),
  [],
  'insights: trivial unattributed spend stays quiet',
)

/* ---------------- coverage and data quality ---------------- */
eq(
  cashFlowIds({ categoryCoverage: 0.457 }),
  ['auto-cashflow-coverage'],
  'insights: low category coverage is surfaced',
)
eq(
  cashFlowIds({ categoryCoverage: 0.95 }),
  [],
  'insights: high coverage needs no insight',
)
// Zero coverage is real and must be reported, not treated as missing.
eq(
  cashFlowIds({ categoryCoverage: 0 }),
  ['auto-cashflow-coverage'],
  'insights: zero coverage is still reported',
)
eq(
  cashFlowIds({ incompleteMonthCount: 4 }),
  ['auto-cashflow-incomplete-months'],
  'insights: incomplete months are surfaced',
)
eq(
  cashFlowIds({ mistypedCategoryCount: 1 }),
  ['auto-cashflow-mistyped'],
  'insights: mistyped categories are surfaced',
)
eq(
  cashFlowIds({ incompleteMonthCount: 0, mistypedCategoryCount: 0 }),
  [],
  'insights: clean data produces no data-quality noise',
)

/* ---------------- singular/plural wording ---------------- */
{
  const one = generateInsights({
    settings,
    pillars,
    cashFlow: { incompleteMonthCount: 1 },
  }).find((i) => i.id === 'auto-cashflow-incomplete-months')
  eq(
    one?.title,
    '1 month is missing bank deposits',
    'insights: singular month wording',
  )
  const many = generateInsights({
    settings,
    pillars,
    cashFlow: { incompleteMonthCount: 4 },
  }).find((i) => i.id === 'auto-cashflow-incomplete-months')
  eq(
    many?.title,
    '4 months are missing bank deposits',
    'insights: plural month wording',
  )
}

/* ---------------- report ---------------- */
console.log(`\ncash-flow insights: ${pass} passed, ${fail} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
