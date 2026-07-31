/**
 * Regression tests for the Marketing Affordability engine.
 *
 * This engine tells the owner how much real money to spend, so the tests focus
 * on the rules that stop it recommending money that is not there:
 *   - the reserve is never raided
 *   - placeholder receivables never become spending headroom
 *   - affordability beats the percentage ceiling
 *   - a weak cash position overrides strong revenue
 *   - confidence falls when the underlying data has holes
 */

import {
  buildRecommendation,
  buildScenarios,
  computeAvailableOperatingCash,
  computeConfidence,
  computeRecommendedBudget,
  computeSeasonality,
  findUncategorizedMarketing,
  placeholderReceivableReason,
  reconcileKnownSpend,
  scoreAffordability,
  summarizeCurrentMarketingSpend,
  addMonths,
  marketingChannelName,
  type ReceivableInput,
} from '../lib/marketing-affordability-service'

let pass = 0
let fail = 0

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(
      `  FAIL ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`,
    )
  }
}

function ok(name: string, condition: boolean, detail = '') {
  if (condition) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`)
  }
}

const rc = (r: Partial<ReceivableInput>): ReceivableInput => ({
  customerName: 'Real Customer',
  invoiceNumber: 'INV-1',
  amount: 1000,
  amountPaid: 0,
  status: 'Outstanding',
  notes: null,
  ...r,
})

console.log('\nMonth helpers')
check('addMonths rolls the year', addMonths('2025-12', 1), '2026-01')
check('addMonths goes backwards', addMonths('2026-01', -1), '2025-12')
check('addMonths spans a year', addMonths('2025-06', 12), '2026-06')

console.log('\nPlaceholder receivables (never become spending headroom)')
check(
  'the real $5,000 "Unknown" placeholder is caught',
  placeholderReceivableReason(rc({ customerName: 'Unknown', invoiceNumber: null, amount: 5000 })),
  'No real customer name',
)
check(
  'notes admitting a placeholder are caught',
  placeholderReceivableReason(rc({ notes: 'Placeholder until invoice arrives' })),
  'Row is labelled a placeholder in its notes',
)
check(
  'a missing invoice number is caught',
  placeholderReceivableReason(rc({ invoiceNumber: '  ' })),
  'No invoice number',
)
check('a genuine receivable passes', placeholderReceivableReason(rc({})), null)

console.log('\nAvailable operating cash')
{
  const r = computeAvailableOperatingCash({
    cashOnHand: 50_000,
    minCashReserve: 20_000,
    receivables: [rc({ amount: 4_000 }), rc({ customerName: 'Unknown', invoiceNumber: null, amount: 5_000 })],
    obligationsDue: 10_000,
    obligationsBasis: 'test',
    monthlyDebtService: 5_000,
    payrollDue: 8_000,
    payrollBasis: 'test',
  })
  check('placeholder receivable excluded from expected cash', r.expectedReceivables, 4_000)
  check('placeholder is reported, not hidden', r.excludedReceivables.length, 1)
  check('deductions total', r.totalDeductions, 23_000)
  // 50,000 + 4,000 - 23,000 = 31,000
  check('projected cash', r.projectedCash, 31_000)
  // 31,000 - 20,000 reserve = 11,000 spendable
  check('available operating cash respects the reserve', r.availableOperatingCash, 11_000)
}
{
  // Regression: every cash_obligations row in this business has a null due_date,
  // so getCashDebtSummary reports obligations30 = $0 and holds them in
  // unscheduledObligations instead. Ignoring those overstated spendable cash by
  // $6,211/month (Rent, Electric, Trash, Gas and an $800 Marketing line).
  const r = computeAvailableOperatingCash({
    cashOnHand: 15_758,
    minCashReserve: 15_000,
    receivables: [],
    obligationsDue: 0,
    obligationsBasis: 'none dated',
    unscheduledObligations: 6_211,
    unscheduledObligationNames: ['Rent', 'Electric', 'Trash', 'Gas', 'Marketing'],
    monthlyDebtService: 817,
    payrollDue: 10_393,
    payrollBasis: 'test',
  })
  ok(
    'undated recurring bills are still deducted',
    r.deductions.some((d) => d.amount === 6_211),
    JSON.stringify(r.deductions.map((d) => `${d.label}=${d.amount}`)),
  )
  ok(
    'the undated bills are named so the owner can fix the dates',
    r.deductions.some((d) => d.basis.includes('Rent') && d.basis.includes('Electric')),
  )
  check('deductions total includes the undated bills', r.totalDeductions, 17_421)
  // 15,758 - 17,421 = -1,663. Previously this reported +$4,548 of cash.
  check('projected cash is negative once real bills count', r.projectedCash, -1_663)
  ok(
    'no marketing headroom is invented',
    r.availableOperatingCash < 0,
    `available ${r.availableOperatingCash}`,
  )
}
{
  const r = computeAvailableOperatingCash({
    cashOnHand: 10_000,
    minCashReserve: 20_000,
    receivables: [],
    obligationsDue: 5_000,
    obligationsBasis: 'test',
    monthlyDebtService: 0,
    payrollDue: 0,
    payrollBasis: 'test',
  })
  ok(
    'a reserve breach reports negative headroom rather than zero',
    r.availableOperatingCash === -15_000,
    `got ${r.availableOperatingCash}`,
  )
  check('zero-value deductions are not listed', r.deductions.length, 1)
}

console.log('\nRecommended budget')
{
  // Healthy business: the percentage ceiling should bind, not affordability.
  const b = computeRecommendedBudget({
    trailingMonthlyRevenue: 65_000,
    baselinePct: 1.5,
    ceilingPct: 3,
    maxSafeTotal: 100_000,
    seasonalIndex: 1.3,
    revenueTrendPct: 10,
    reserveCoverage: 3,
    payrollPct: 20,
    targetPayrollPct: 25,
    creditUtilization: 0,
  })
  check('baseline is the revenue percentage', b.baseline, 975)
  // 975 x 1.15 strong cash x 1.1 growth x 1.2 season = 1,480.05, which is still
  // under the 3% ceiling of 1,950 — so nothing should clamp it.
  ok('a strong month raises the figure', b.adjusted > b.baseline, `adjusted ${b.adjusted}`)
  ok('an unclamped recommendation equals the adjusted figure', b.recommended === b.adjusted)
  check('nothing binds a comfortable recommendation', b.boundBy, 'none')
}
{
  // Push the baseline to the ceiling so the upward adjustments must be clamped.
  const b = computeRecommendedBudget({
    trailingMonthlyRevenue: 65_000,
    baselinePct: 3,
    ceilingPct: 3,
    maxSafeTotal: 100_000,
    seasonalIndex: 1.3,
    revenueTrendPct: 10,
    reserveCoverage: 3,
    payrollPct: 20,
    targetPayrollPct: 25,
    creditUtilization: 0,
  })
  check('the percentage ceiling is enforced', b.recommended, 1_950)
  check('bound by the ceiling', b.boundBy, 'ceiling')
}
{
  // Thin cash: affordability must win even though revenue is identical.
  const b = computeRecommendedBudget({
    trailingMonthlyRevenue: 65_000,
    baselinePct: 1.5,
    ceilingPct: 3,
    maxSafeTotal: 300,
    seasonalIndex: 1.3,
    revenueTrendPct: 10,
    reserveCoverage: 3,
    payrollPct: 20,
    targetPayrollPct: 25,
    creditUtilization: 0,
  })
  check('affordability caps the recommendation', b.recommended, 300)
  check('bound by affordability', b.boundBy, 'affordability')
}
{
  // Below reserve: recommendation must collapse toward zero, never negative.
  const b = computeRecommendedBudget({
    trailingMonthlyRevenue: 65_000,
    baselinePct: 1.5,
    ceilingPct: 3,
    maxSafeTotal: 0,
    seasonalIndex: 1,
    revenueTrendPct: 0,
    reserveCoverage: 0.4,
    payrollPct: 40,
    targetPayrollPct: 25,
    creditUtilization: 0.9,
  })
  check('no marketing recommended when nothing is affordable', b.recommended, 0)
  ok('never returns a negative budget', b.recommended >= 0)
  ok(
    'the cash shortfall is cited as a reason',
    b.adjustments.some((a) => /reserve/i.test(a.label + a.reason)),
    JSON.stringify(b.adjustments.map((a) => a.label)),
  )
}

console.log('\nAffordability score')
{
  const strong = scoreAffordability({
    reserveCoverage: 3,
    daysCashOnHand: 60,
    daysCashTarget: 30,
    netMonthlyCashFlow: 10_000,
    trailingMonthlyRevenue: 65_000,
    payrollPct: 18,
    targetPayrollPct: 25,
    creditUtilization: 0.05,
    additionalSafe: 40_000,
  })
  const weak = scoreAffordability({
    reserveCoverage: 0.3,
    daysCashOnHand: 4,
    daysCashTarget: 30,
    netMonthlyCashFlow: -8_000,
    trailingMonthlyRevenue: 65_000,
    payrollPct: 42,
    targetPayrollPct: 25,
    creditUtilization: 0.95,
    additionalSafe: 0,
  })
  ok('strong position scores above weak', strong.score > weak.score, `${strong.score} vs ${weak.score}`)
  ok('score stays within 0-100', strong.score <= 100 && weak.score >= 0, `${strong.score}/${weak.score}`)
  check('weakest position is told not to increase', weak.band, 'Do Not Increase')
  ok('every score shows its workings', strong.components.length >= 4)
}

console.log('\nScenarios')
{
  const s = buildScenarios({
    projectedCash: 31_000,
    minCashReserve: 20_000,
    avgDailyOutflow: 1_000,
    increments: [1_000, 10_000, 12_000, 40_000],
  })
  check('a small increase is safe', s[0].risk, 'Safe')
  // 31,000 - 10,000 = 21,000, only 1,000 above a 20,000 reserve => thin.
  check('an increase that nearly hits the reserve is flagged', s[1].risk, 'High Risk')
  check('an increase that breaches the reserve is unsafe', s[2].risk, 'Unsafe')
  check('an increase that overdraws is unsafe', s[3].risk, 'Unsafe')
  ok('the reserve breach is quantified', /Breaches the reserve/.test(s[2].note), s[2].note)
  ok(
    'scenarios never claim negative days of cash',
    s.every((x) => x.daysCashOnHand >= 0),
  )
}

console.log('\nSeasonality')
{
  // Two years, December double a normal month.
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => ({
      monthKey: `2024-${String(i + 1).padStart(2, '0')}`,
      revenue: i === 11 ? 100_000 : 50_000,
    })),
    ...Array.from({ length: 12 }, (_, i) => ({
      monthKey: `2025-${String(i + 1).padStart(2, '0')}`,
      revenue: i === 11 ? 100_000 : 50_000,
    })),
  ]
  const s = computeSeasonality(rows, '2026-12')
  ok('December is identified as the peak', s.strongMonths[0] === 'December', JSON.stringify(s.strongMonths))
  ok('December indexes above average', (s.nextMonth?.index ?? 0) > 1.5, String(s.nextMonth?.index))
  check('the target month is selected', s.nextMonth?.label, 'December')
  ok(
    'a month with no history indexes neutrally rather than at zero',
    computeSeasonality([{ monthKey: '2025-03', revenue: 1000 }], '2025-07').nextMonth?.index === 1,
  )
}

console.log('\nMarketing spend summary')
{
  const now = new Date('2026-07-15T00:00:00')
  const txns = [
    { id: '1', transactionDate: '2026-07-01', description: 'FACEBK *BBMFW9H6N2', amount: -200, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: 'Marketing', vendorId: null },
    { id: '2', transactionDate: '2026-06-10', description: 'GOOGLE ADS 4471', amount: -300, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: 'Marketing', vendorId: null },
    { id: '3', transactionDate: '2026-06-20', description: 'EXCLUDED ROW', amount: -900, transactionType: 'expense', reviewStatus: 'excluded', expenseCategory: 'Marketing', vendorId: null },
    { id: '4', transactionDate: '2026-06-21', description: 'FEED STORE', amount: -400, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: 'Cost of Goods', vendorId: null },
    // Categorized only on the vendor, not the row: must still count.
    { id: '5', transactionDate: '2026-06-22', description: 'LOCAL SIGN CO', amount: -150, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: 'v-mk' },
  ]
  const s = summarizeCurrentMarketingSpend(txns as never, new Set(['v-mk']), now)
  ok('non-marketing spend is ignored', s.lifetimeTotal === 650, `lifetime ${s.lifetimeTotal}`)
  ok('excluded rows are ignored', !JSON.stringify(s).includes('900'))
  ok('vendor-classified marketing is counted', s.rows.some((r) => r.via === 'vendor'))
  ok(
    'the two Facebook charge tokens collapse to one channel',
    s.channels.length === 3,
    JSON.stringify(s.channels.map((c) => c.name)),
  )
}
check(
  'a unique charge token becomes a readable channel',
  marketingChannelName('FACEBK *BBMFW9H6N2 650-543-7818 CA'),
  'Facebook / Meta Ads',
)
// Regression: Meta also bills through PayPal as one unspaced word, which the
// old `META PLATFORMS` pattern missed entirely.
check(
  'Meta routed through PayPal is recognised',
  marketingChannelName('PAYPAL INST XFER METAPLATFOR'),
  'Facebook / Meta Ads',
)
// `\bSIGNS?\b` must not fire on DESIGN, so this falls through to the generic
// fallback rather than being mislabelled as signage.
check(
  'DESIGN must not match the SIGN pattern',
  marketingChannelName('WEB DESIGN CO'),
  'WEB DESIGN CO',
)

console.log('\nUncategorized marketing detection')
{
  // Regression: the owner spends ~$1,200/mo but the page reported $16/mo,
  // because real advertising sat under a BLANK category and so was excluded
  // from every marketing figure.
  const rows = [
    { id: '1', transactionDate: '2025-12-05', description: 'BAYOU SIGNS OUTD SALE', amount: -450, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: null },
    { id: '2', transactionDate: '2025-12-10', description: 'PAYPAL INST XFER METAPLATFOR', amount: -92, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: null },
    { id: '3', transactionDate: '2025-09-08', description: 'Coastal Broadcas PURCHASE 19712472', amount: -1050, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: null },
    { id: '4', transactionDate: '2025-12-05', description: 'PAYPAL INST XFER VISTAPRINT', amount: -618.1, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: null },
    // Already categorized: must NOT be offered again as a suggestion.
    { id: '5', transactionDate: '2025-12-15', description: 'FACEBK *BBMFW9H6N2', amount: -98, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: 'Marketing', vendorId: null },
    // Genuinely not marketing.
    { id: '6', transactionDate: '2025-12-16', description: 'ENTERGY LOUISIAN BANK DRAFT', amount: -1800, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: null },
    // Excluded rows stay excluded.
    { id: '7', transactionDate: '2025-12-17', description: 'BAYOU SIGNS OUTD SALE', amount: -9999, transactionType: 'expense', reviewStatus: 'excluded', expenseCategory: '', vendorId: null },
    // Vendor already marked marketing: counted elsewhere, not a suggestion.
    { id: '8', transactionDate: '2025-12-18', description: 'LAMAR BILLBOARD', amount: -500, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: 'v-mk' },
  ]
  const u = findUncategorizedMarketing(rows as never, new Set(['v-mk']))
  // 450 + 92 + 1050 + 618.10 = 2,210.10
  check('uncategorized advertising is totalled', Math.round(u.total * 100) / 100, 2210.1)
  ok('already-categorized marketing is not re-suggested', !JSON.stringify(u).includes('98,'))
  ok('a marketing vendor is not re-suggested', !JSON.stringify(u).includes('500'))
  ok('utilities are not mistaken for marketing', !JSON.stringify(u).includes('1800'))
  ok('excluded rows stay excluded', !JSON.stringify(u).includes('9999'))
  check('billboards, broadcast, print and Meta are separated', u.channels.length, 4)
  // Regression: dividing by ACTIVE months (2) reported $1,105/mo for charges that
  // actually span Sep -> Dec (4 calendar months), overstating the rate ~2x. The
  // averages elsewhere already use a calendar window; this must match, or the
  // figure shown to the owner is inflated by whatever gaps the ledger has.
  check('the span is calendar months, gaps included', u.monthsSpanned, 4)
  check('and the empty months are counted', u.monthsWithoutCharges, 2)
  ok(
    'the implied monthly rate uses the calendar span',
    Math.round(u.impliedMonthly) === 553,
    `implied ${u.impliedMonthly}, expected ~552.53`,
  )
  check(
    'the first and last month are reported',
    `${u.firstMonth}->${u.lastMonth}`,
    '2025-09->2025-12',
  )
  // Regression: `BAYOU SIGNS OUTD` is a BILLBOARD vendor (OUTD = outdoor), but it
  // matched the signage pattern first, so the owner did not recognise their own
  // $450/mo billboard spend in the callout.
  ok(
    'an OUTD vendor is billboards, not signage',
    u.channels.some((c) => c.channel === 'Billboards / outdoor' && c.amount === 450),
    JSON.stringify(u.channels.map((c) => `${c.channel}=${c.amount}`)),
  )
  ok(
    'the biggest channel is listed first so the owner fixes it first',
    u.channels[0].channel === 'Radio / TV advertising',
    JSON.stringify(u.channels.map((c) => `${c.channel}=${c.amount}`)),
  )
}
check(
  'a billboard vendor is named as outdoor advertising',
  marketingChannelName('BAYOU SIGNS OUTD SALE'),
  'Billboards / outdoor',
)
check(
  'plain signage is still signage',
  marketingChannelName('ACME BANNER CO'),
  'Signage / printing',
)
{
  // Clean books must produce no noise at all.
  const u = findUncategorizedMarketing(
    [
      { id: '1', transactionDate: '2026-06-01', description: 'FACEBK *AAA', amount: -100, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: 'Marketing', vendorId: null },
    ] as never,
    new Set<string>(),
  )
  check('fully categorized books report nothing', u.channels.length, 0)
  check('and no implied monthly figure is invented', u.impliedMonthly, 0)
  // No charges means no span at all — not a bogus 1-month span that would make a
  // later division look meaningful.
  check('no calendar span is invented', u.monthsSpanned, 0)
  check('and no month bounds are invented', `${u.firstMonth}/${u.lastMonth}`, 'null/null')
}
{
  // A single charge spans exactly one month, so the implied rate is that charge.
  const u = findUncategorizedMarketing(
    [
      { id: '1', transactionDate: '2026-06-01', description: 'LAMAR BILLBOARD', amount: -500, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: null },
    ] as never,
    new Set<string>(),
  )
  check('a single month spans one month, not zero', u.monthsSpanned, 1)
  check('and the implied rate is that single charge', u.impliedMonthly, 500)
  check('with no empty months', u.monthsWithoutCharges, 0)
}

console.log('\nSpend reconciliation (why the average disagrees with reality)')
{
  // Regression: the owner states ~$950/mo of marketing, but billboards and radio
  // have no charge since Dec 2025, so every trailing average reads near zero. The
  // page must say those channels went quiet rather than implying they stopped.
  const today = new Date('2026-07-31T00:00:00')
  const rows = [
    { id: '1', transactionDate: '2025-11-07', description: 'BAYOU SIGNS OUTD SALE', amount: -450, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: null },
    { id: '2', transactionDate: '2025-12-05', description: 'BAYOU SIGNS OUTD SALE', amount: -450, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: null },
    { id: '3', transactionDate: '2026-06-27', description: 'FACEBK *ZQK5YVV6N2', amount: -47.65, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: 'Marketing', vendorId: null },
    // No payee at all: structurally unattributable.
    { id: '4', transactionDate: '2026-06-10', description: 'CHECK', amount: -2000, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: null },
    { id: '5', transactionDate: '2026-05-10', description: 'CHECK', amount: -1000, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: '', vendorId: null },
    // Income must never be counted as unattributable outflow.
    { id: '6', transactionDate: '2026-06-11', description: 'DEPOSIT', amount: 5000, transactionType: 'income', reviewStatus: 'reviewed', expenseCategory: '', vendorId: null },
  ]
  const r = reconcileKnownSpend(rows as never, new Set<string>(), today)
  ok(
    'a channel quiet for months is reported as lapsed',
    r.lapsed.some((l) => l.channel === 'Billboards / outdoor' && l.monthsSinceLastCharge === 7),
    JSON.stringify(r.lapsed),
  )
  ok(
    'the lapsed channel reports what it used to cost',
    r.lapsed.find((l) => l.channel === 'Billboards / outdoor')?.typicalMonthly === 450,
    JSON.stringify(r.lapsed),
  )
  ok(
    'a channel that billed this month is NOT called lapsed',
    !r.lapsed.some((l) => l.channel === 'Facebook / Meta Ads'),
    JSON.stringify(r.lapsed.map((l) => l.channel)),
  )
  check('recent activity is detected', r.hasRecentActivity, true)
  check('payee-less outflows are totalled', r.unattributable.total, 3000)
  check('and counted', r.unattributable.count, 2)
  ok(
    'income is never counted as unattributable spend',
    !JSON.stringify(r.unattributable).includes('5000'),
    JSON.stringify(r.unattributable),
  )
}
{
  // Clean, current books: nothing to explain, so no noise.
  const r = reconcileKnownSpend(
    [
      { id: '1', transactionDate: '2026-07-05', description: 'FACEBK *AAA', amount: -250, transactionType: 'expense', reviewStatus: 'reviewed', expenseCategory: 'Marketing', vendorId: null },
    ] as never,
    new Set<string>(),
    new Date('2026-07-31T00:00:00'),
  )
  check('current spend produces no lapsed warnings', r.lapsed.length, 0)
  check('and no unattributable spend is invented', r.unattributable.total, 0)
}

console.log('\nConfidence')
{
  const clean = computeConfidence({
    revenueMonths: 25,
    revenueMonthsFromApi: 25,
    categorizedSpendPct: 1,
    incompleteMonths: [],
    gapMonths: [],
    totalMonthsCovered: 25,
    balancesUpdatedDaysAgo: 0,
    hasRealReceivables: true,
    excludedReceivableCount: 0,
  })
  const holey = computeConfidence({
    revenueMonths: 25,
    revenueMonthsFromApi: 25,
    categorizedSpendPct: 0.425,
    incompleteMonths: ['January 2026'],
    gapMonths: ['July 2025', 'August 2025'],
    totalMonthsCovered: 25,
    balancesUpdatedDaysAgo: 90,
    hasRealReceivables: false,
    excludedReceivableCount: 1,
  })
  check('clean data reports full expense confidence', clean.expense.pct, 100)
  ok('holey data lowers expense confidence', holey.expense.pct < 50, String(holey.expense.pct))
  ok('missing months lower cash-flow confidence', holey.cashFlow.pct < clean.cashFlow.pct)
  ok('the gaps are listed in plain language', holey.gaps.length >= 3, JSON.stringify(holey.gaps))
  ok(
    'the missing bank months are named',
    holey.gaps.some((c) => /July 2025/.test(c)),
    JSON.stringify(holey.gaps),
  )
  ok('a stale balance is called out', holey.gaps.some((c) => /balance/i.test(c)))
}

console.log('\nRecommendation wording')
{
  const hold = buildRecommendation({
    band: 'Do Not Increase',
    currentMonthlyMarketing: 270,
    recommended: 0,
    additionalSafe: -15_000,
    reserveCoverage: 0.4,
    revenueTrendPct: 8,
    seasonalIndex: 1.3,
    seasonalLabel: 'December',
    payrollPct: 40,
    targetPayrollPct: 25,
    obligationsDue: 50_000,
    boundBy: 'affordability',
  })
  // $270/month is already going out while the reserve is broken, so the honest
  // advice is to cut it, not merely to hold at the current level.
  check('a broken reserve with live spend advises a cut', hold.action, 'reduce')
  ok('the blocker is stated', hold.blockers.length > 0, JSON.stringify(hold.blockers))
  ok(
    'growth is not used to justify spending that is unaffordable',
    !/increase/i.test(hold.summary),
    hold.summary,
  )

  const grow = buildRecommendation({
    band: 'Excellent',
    currentMonthlyMarketing: 270,
    recommended: 1_300,
    additionalSafe: 40_000,
    reserveCoverage: 3,
    revenueTrendPct: 8,
    seasonalIndex: 1.3,
    seasonalLabel: 'December',
    payrollPct: 20,
    targetPayrollPct: 25,
    obligationsDue: 5_000,
    boundBy: 'none',
  })
  check('a strong position supports an increase', grow.action, 'increase')
  check('the increase is the delta, not the total', grow.amount, 1_030)
  ok('the reasons cite real drivers', grow.reasons.length >= 2, JSON.stringify(grow.reasons))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
