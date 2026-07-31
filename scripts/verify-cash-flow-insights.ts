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

/* ---------------- marketing affordability insights ---------------- */
// The advisor must never invite spending that the Marketing Budget page would
// call unaffordable, and must stay silent when there is no data at all.
type MarketingArg = NonNullable<Parameters<typeof generateInsights>[0]['marketing']>

const affordable: MarketingArg = {
  recommended: 1200,
  current: 800,
  categorizedMonthly: 800,
  additionalSafe: 5000,
  band: 'Comfortable',
  action: 'increase',
  summary: 'Raise marketing to $1,200 a month.',
  blockers: [],
  reserveCoverage: 2.4,
  commitmentMismatch: null,
  confidenceLabel: 'Moderate',
  seasonalLabel: 'December',
  seasonalIndex: 1.3,
  uncategorized: null,
  lapsedChannels: [],
}

function marketingIds(marketing?: MarketingArg): string[] {
  return generateInsights({ settings, pillars, marketing })
    .filter((i) => i.id.startsWith('auto-marketing-'))
    .map((i) => i.id)
    .sort()
}

eq(marketingIds(undefined), [], 'marketing: no group means no insights')

eq(
  marketingIds(affordable),
  ['auto-marketing-headroom'],
  'marketing: real headroom is offered as an opportunity',
)

// The most important rule on this surface. When bills already exceed cash, the
// advisor must raise a critical flag and must NOT name a spendable budget.
{
  const broke: MarketingArg = {
    ...affordable,
    recommended: 229,
    current: 800,
    additionalSafe: 0,
    band: 'No Capacity',
    action: 'reduce',
    reserveCoverage: -0.11,
    summary: 'Cut marketing spend as far as existing commitments allow.',
    blockers: ['This month\u2019s known bills come to more than the cash on hand, before any marketing.'],
  }
  const insight = generateInsights({ settings, pillars, marketing: broke }).find(
    (i) => i.id === 'auto-marketing-no-room',
  )
  eq(insight?.severity, 'critical', 'marketing: negative cash is critical')
  eq(
    insight?.detail.includes('$229'),
    false,
    'marketing: no spendable budget is quoted when cash is negative',
  )
  eq(
    insight?.detail.includes('more than the cash on hand'),
    true,
    'marketing: the blocker is stated in plain language',
  )
  // `summary` already ends with the first blocker, so appending all blockers
  // printed the same sentence twice on the Advisor page.
  const bills = insight?.detail.match(/more than the cash on hand/g) ?? []
  eq(bills.length, 1, 'marketing: the blocker sentence is not duplicated')
  // A negative coverage must never be rendered as a percentage of target.
  eq(
    /-\d+%/.test(insight?.detail ?? ''),
    false,
    'marketing: negative coverage is not shown as a percentage',
  )
}

// Overspending against a positive but insufficient cash position.
{
  const over: MarketingArg = {
    ...affordable,
    recommended: 400,
    current: 1000,
    additionalSafe: 0,
    action: 'reduce',
    band: 'Do Not Increase',
    reserveCoverage: 0.8,
    blockers: ['Known obligations would leave cash at 80% of the reserve target.'],
  }
  const insight = generateInsights({ settings, pillars, marketing: over }).find(
    (i) => i.id === 'auto-marketing-reduce',
  )
  eq(insight?.severity, 'warning', 'marketing: overspending warns')
  eq(insight?.impact, 'Reduce by $600/mo', 'marketing: impact is the real delta')
}

// A committed budget that is not being spent is worth surfacing on its own.
eq(
  marketingIds({
    ...affordable,
    action: 'maintain',
    commitmentMismatch: { committed: 800, actual: 270, note: 'Budget not fully spent.' },
  }),
  ['auto-marketing-commitment-gap'],
  'marketing: a commitment gap is surfaced even when no change is advised',
)

// Regression: the Marketing page reported $16/mo against a real ~$1,200/mo,
// because advertising sat under a blank category. The advisor must explain that
// gap rather than quietly advising against an understated baseline.
{
  const understated: MarketingArg = {
    ...affordable,
    // Deliberately different: `current` is the $800 committed obligation, while
    // $16 is the categorized spend the owner actually sees. The first version of
    // this insight quoted `current` and so pointed at the wrong number — the
    // fixture must keep them apart to catch that.
    current: 800,
    categorizedMonthly: 16,
    uncategorized: {
      total: 5962,
      impliedMonthly: 1192,
      topChannels: ['Signage / printing', 'Radio / TV advertising', 'Facebook / Meta Ads'],
    },
  }
  const insight = generateInsights({ settings, pillars, marketing: understated }).find(
    (i) => i.id === 'auto-marketing-uncategorized',
  )
  eq(insight?.severity, 'warning', 'marketing: uncategorized advertising warns')
  eq(
    insight?.title,
    '$1,192/mo of advertising is not categorized as marketing',
    'marketing: the title states the monthly rate the owner would recognise',
  )
  eq(
    insight?.detail.includes('Signage / printing'),
    true,
    'marketing: the channels to fix are named',
  )
  // The whole point is to explain the number the owner disputes.
  eq(
    insight?.detail.includes('$16/mo is understated'),
    true,
    'marketing: the understated figure is named so the gap is explained',
  )
  // Regression: quoting the $800 commitment here pointed at a number the owner
  // never questioned and made the sentence read as wrong.
  eq(
    insight?.detail.includes('$800/mo is understated'),
    false,
    'marketing: the committed obligation is not mistaken for reported spend',
  )
  // A provisional budget must not be presented as settled advice.
  eq(
    insight?.detail.includes('provisional'),
    true,
    'marketing: the budget is flagged provisional until categories are fixed',
  )
}

// Clean books must not produce this insight at all.
eq(
  marketingIds({ ...affordable, action: 'maintain' }),
  [],
  'marketing: fully categorized books produce no uncategorized warning',
)

// Regression: the owner states ~$950/mo of marketing (billboards, spokesman,
// Facebook) but billboards and radio have no charge in months, so every trailing
// average reads near zero. The advisor must say those channels went quiet rather
// than advising against a baseline that silently treats them as ended.
{
  const lapsed: MarketingArg = {
    ...affordable,
    categorizedMonthly: 16,
    lapsedChannels: [
      {
        channel: 'Radio / TV advertising',
        lastDate: '2025-09-08',
        monthsSinceLastCharge: 10,
        typicalMonthly: 875,
      },
      {
        channel: 'Billboards / outdoor',
        lastDate: '2025-12-05',
        monthsSinceLastCharge: 7,
        typicalMonthly: 535,
      },
    ],
  }
  const insight = generateInsights({ settings, pillars, marketing: lapsed }).find(
    (i) => i.id === 'auto-marketing-lapsed',
  )
  eq(insight?.severity, 'warning', 'marketing: lapsed channels warn')
  eq(
    insight?.title,
    '2 marketing channels stopped appearing in the bank feed',
    'marketing: the title counts the quiet channels',
  )
  eq(
    insight?.impact,
    'Marketing baseline understated',
    'marketing: the impact does not quote an unmeasurable amount',
  )
  // Regression: summing the per-channel averages produced "$1,410/mo unaccounted"
  // against a real ~$950/mo. Those averages cover different, non-overlapping
  // periods, so adding them asserts a concurrent total that was never paid.
  eq(
    /\$1,410/.test(JSON.stringify(insight)),
    false,
    'marketing: non-concurrent channel averages are never summed',
  )
  eq(
    insight?.detail.includes('must not be added together'),
    true,
    'marketing: the reason the total is unknowable is stated',
  )
  // Naming the date is what lets the owner confirm or deny it from memory.
  eq(
    insight?.detail.includes('last billed 2025-12-05'),
    true,
    'marketing: each channel reports when it was last seen',
  )
  // The point is that this is a data gap, not a spending decision.
  eq(
    insight?.detail.includes('cannot attribute'),
    true,
    'marketing: the reason the money is invisible is stated',
  )
  eq(
    insight?.detail.includes('Confirm whether each channel actually ended'),
    true,
    'marketing: the owner is asked to confirm before trusting the budget',
  )
}
// A single quiet channel is named directly rather than counted.
{
  const one = generateInsights({
    settings,
    pillars,
    marketing: {
      ...affordable,
      lapsedChannels: [
        {
          channel: 'Billboards / outdoor',
          lastDate: '2025-12-05',
          monthsSinceLastCharge: 7,
          typicalMonthly: 535,
        },
      ],
    },
  }).find((i) => i.id === 'auto-marketing-lapsed')
  eq(
    one?.title,
    'Billboards / outdoor stopped appearing in the bank feed',
    'marketing: a single quiet channel is named in the title',
  )
}

/* ---------------- report ---------------- */
console.log(`\ncash-flow insights: ${pass} passed, ${fail} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
