/**
 * Verification for lib/cash-flow-service.ts — npx tsx scripts/verify-cash-flow.ts
 *
 * The failures that matter here are silent and wrong-by-a-lot: months from two
 * years interleaving, a credit-card payment double-counting purchases already
 * recorded, $292k of CHECK spend being presented as a real vendor, or income
 * categories leaking into a "where did my money go" breakdown. Each has a test.
 */

import {
  cashDirectionOf,
  deriveMonthlyCashFlow,
  summarizeOutflowsByPayee,
  summarizeSpendByCategory,
  resolveExpenseCategory,
  canonicalCategory,
  monthLabel,
  UNCATEGORIZED,
  type CashFlowInputRow,
} from '../lib/cash-flow-service'
import { buildApprovedAliasMap } from '../lib/categories'
import type { ReviewStatus, TransactionType } from '../lib/transactions'

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

let seq = 0
function row(
  partial: Partial<CashFlowInputRow> & { amount: number; transactionDate: string },
): CashFlowInputRow {
  seq += 1
  return {
    id: `t${seq}`,
    description: partial.description ?? 'DESC',
    normalizedDescription: partial.normalizedDescription ?? 'DESC',
    transactionType: (partial.transactionType ?? 'expense') as TransactionType,
    reviewStatus: (partial.reviewStatus ?? 'matched') as ReviewStatus,
    vendorId: partial.vendorId ?? null,
    expenseCategory: partial.expenseCategory ?? '',
    accountName: partial.accountName ?? 'Checking',
    ...partial,
  }
}

/* ---------------- direction ---------------- */
eq(cashDirectionOf('income'), 'in', 'direction: income is in')
eq(cashDirectionOf('expense'), 'out', 'direction: expense is out')
eq(cashDirectionOf('fee'), 'out', 'direction: fee is out')
eq(cashDirectionOf('interest'), 'out', 'direction: interest is out')
eq(cashDirectionOf('refund'), 'offset', 'direction: refund offsets')
eq(cashDirectionOf('credit'), 'offset', 'direction: credit offsets')
// The double-counting guard: these move money but are not spend.
eq(cashDirectionOf('transfer'), 'neutral', 'direction: transfer is neutral')
eq(cashDirectionOf('payment'), 'neutral', 'direction: card payment is neutral')

/* ---------------- month labels ---------------- */
eq(monthLabel('2025-01'), "Jan '25", 'label: January 2025')
eq(monthLabel('2026-12'), "Dec '26", 'label: December 2026')

/* ---------------- monthly series ---------------- */
{
  const result = deriveMonthlyCashFlow([
    row({ transactionDate: '2025-06-01', amount: -100, transactionType: 'expense' }),
    row({ transactionDate: '2025-06-15', amount: 500, transactionType: 'income' }),
    row({ transactionDate: '2026-01-10', amount: -50, transactionType: 'expense' }),
  ])
  // Two June rows collapse into one bucket, so this is two months, not three.
  eq(result.series.length, 2, 'monthly: two distinct months')
  eq(result.series[0].monthKey, '2025-06', 'monthly: earliest first')
  eq(result.series[0].inflow, 500, 'monthly: inflow summed')
  eq(result.series[0].outflow, 100, 'monthly: outflow is absolute')
  eq(result.series[0].net, 400, 'monthly: net = in - out')
  eq(result.latestMonth?.monthKey, '2026-01', 'monthly: latest month is last')
}

// The bug this design exists to prevent: ordering by month name would place
// Jan 2026 before Jun 2025.
{
  const result = deriveMonthlyCashFlow([
    row({ transactionDate: '2026-01-05', amount: -10 }),
    row({ transactionDate: '2025-06-05', amount: -20 }),
    row({ transactionDate: '2025-12-05', amount: -30 }),
  ])
  eq(
    result.series.map((s) => s.monthKey),
    ['2025-06', '2025-12', '2026-01'],
    'monthly: sorts across a year boundary',
  )
}

// Transfers/payments must not inflate outflow, but must be reported.
{
  const result = deriveMonthlyCashFlow([
    row({ transactionDate: '2025-06-01', amount: -100, transactionType: 'expense' }),
    row({ transactionDate: '2025-06-02', amount: -900, transactionType: 'payment' }),
    row({ transactionDate: '2025-06-03', amount: -400, transactionType: 'transfer' }),
  ])
  eq(result.series[0].outflow, 100, 'monthly: card payment excluded from outflow')
  eq(result.excluded.transfersAndPayments, 1300, 'monthly: excluded total reported')
  eq(result.excluded.count, 2, 'monthly: excluded count reported')
}

// Refunds reverse spend rather than counting as income.
{
  const result = deriveMonthlyCashFlow([
    row({ transactionDate: '2025-06-01', amount: -100, transactionType: 'expense' }),
    row({ transactionDate: '2025-06-05', amount: 30, transactionType: 'refund' }),
  ])
  eq(result.series[0].outflow, 70, 'monthly: refund reduces outflow')
  eq(result.series[0].inflow, 0, 'monthly: refund is not inflow')
}

// Excluded rows and undated rows contribute nothing.
{
  const result = deriveMonthlyCashFlow([
    row({ transactionDate: '2025-06-01', amount: -100, reviewStatus: 'excluded' }),
    row({ transactionDate: '', amount: -100 }),
  ])
  eq(result.series.length, 0, 'monthly: excluded and undated rows ignored')
  eq(result.latestMonth, null, 'monthly: no latest month without data')
}

eq(deriveMonthlyCashFlow([]).series.length, 0, 'monthly: empty input is empty')

/* ---------------- statement coverage ---------------- */
// The real data has months where only a credit-card statement was imported, so
// inflow is 0 while spending is real. Reporting that as a month of pure loss
// would be flatly wrong, so such months are marked incomplete.
{
  const result = deriveMonthlyCashFlow([
    row({
      transactionDate: '2026-04-01',
      amount: -100,
      accountName: 'Checking 2268',
    }),
    row({
      transactionDate: '2026-04-02',
      amount: 900,
      transactionType: 'income',
      accountName: 'Checking 2268',
    }),
    // Card-only month: spend, no deposits.
    row({ transactionDate: '2026-05-01', amount: -80, accountName: 'Amex 73009' }),
  ])
  eq(result.series[0].complete, true, 'coverage: month with deposits is complete')
  eq(result.series[1].complete, false, 'coverage: card-only month is incomplete')
  eq(result.incompleteMonths, ['2026-05'], 'coverage: incomplete months listed')
  eq(result.latestMonth?.monthKey, '2026-05', 'coverage: latest is still newest')
  eq(
    result.latestCompleteMonth?.monthKey,
    '2026-04',
    'coverage: latest complete skips card-only month',
  )
  eq(result.series[0].accounts, ['Checking 2268'], 'coverage: accounts recorded')
}

// Months with no statements at all are reported as gaps, not silently skipped.
{
  const result = deriveMonthlyCashFlow([
    row({ transactionDate: '2025-06-01', amount: -10 }),
    row({ transactionDate: '2025-09-01', amount: -10 }),
  ])
  eq(result.gapMonths, ['2025-07', '2025-08'], 'coverage: missing months detected')
}

// A gap spanning a year boundary must not loop forever or miscount.
{
  const result = deriveMonthlyCashFlow([
    row({ transactionDate: '2025-11-01', amount: -10 }),
    row({ transactionDate: '2026-02-01', amount: -10 }),
  ])
  eq(result.gapMonths, ['2025-12', '2026-01'], 'coverage: gap across year boundary')
}

eq(deriveMonthlyCashFlow([]).gapMonths, [], 'coverage: no gaps without data')
eq(
  deriveMonthlyCashFlow([row({ transactionDate: '2025-06-01', amount: -10 })]).gapMonths,
  [],
  'coverage: single month has no gaps',
)

// Trailing window keeps the most recent months.
{
  const rows = Array.from({ length: 14 }, (_, i) =>
    row({
      transactionDate: `2025-${String((i % 12) + 1).padStart(2, '0')}-01`,
      amount: -10,
    }),
  )
  const result = deriveMonthlyCashFlow(rows, { months: 3 })
  eq(result.series.length, 3, 'monthly: window limits length')
  eq(result.series[2].monthKey, '2025-12', 'monthly: window keeps newest')
}

/* ---------------- outflows by payee ---------------- */
{
  const result = summarizeOutflowsByPayee([
    row({ transactionDate: '2025-06-01', amount: -600, normalizedDescription: 'SYSCO FOODS' }),
    row({ transactionDate: '2025-06-02', amount: -400, normalizedDescription: 'SYSCO FOODS' }),
    row({ transactionDate: '2025-06-03', amount: -1000, normalizedDescription: 'CHECK 1041' }),
  ])
  eq(result.totalOutflow, 2000, 'payees: total includes unidentified')
  eq(result.payees.length, 1, 'payees: one identified payee')
  eq(result.payees[0].amount, 1000, 'payees: same payee merged')
  eq(result.payees[0].count, 2, 'payees: count merged')
  eq(result.payees[0].share, 0.5, 'payees: share of total')
  // The $292k CHECK problem: never presented as a vendor.
  eq(result.unidentified.amount, 1000, 'payees: check spend isolated')
  eq(result.unidentified.share, 0.5, 'payees: unidentified share')
}

// A fully refunded payee is not an outflow.
{
  const result = summarizeOutflowsByPayee([
    row({ transactionDate: '2025-06-01', amount: -100, normalizedDescription: 'ACME TOOLS' }),
    row({
      transactionDate: '2025-06-02',
      amount: 100,
      transactionType: 'refund',
      normalizedDescription: 'ACME TOOLS',
    }),
  ])
  eq(result.payees.length, 0, 'payees: net-zero payee dropped')
  eq(result.totalOutflow, 0, 'payees: net-zero total')
}

eq(summarizeOutflowsByPayee([]).totalOutflow, 0, 'payees: empty input')

/* ---------------- category canonicalisation ---------------- */
// Nothing groups without an approval. The shipped seed suggestions must have
// ZERO effect on reporting until the owner approves them, so every stored label
// reports under its own name here.
eq(canonicalCategory('Packaging'), 'Packaging', 'canon: seed alias does NOT group')
eq(
  canonicalCategory('Labels & Packaging'),
  'Labels & Packaging',
  'canon: second seed variant stays separate',
)
eq(canonicalCategory('Meat / COGS'), 'Meat / COGS', 'canon: cogs line stays separate')
eq(canonicalCategory('Bakery / COGS'), 'Bakery / COGS', 'canon: cogs line stays separate')
eq(canonicalCategory('Software'), 'Software', 'canon: software stays separate')
eq(canonicalCategory('Payroll'), 'Payroll', 'canon: unmapped value preserved')
eq(canonicalCategory(''), UNCATEGORIZED, 'canon: blank is uncategorized')
// Ambiguous pairs must NOT be merged silently.
eq(
  canonicalCategory('Equipment & Supplies'),
  'Equipment & Supplies',
  'canon: ambiguous equipment left alone',
)
// An APPROVED alias is the only thing that groups, and only for display.
{
  const approved = buildApprovedAliasMap([
    { fromCategories: ['Packaging', 'Labels & Packaging'], toCategory: 'Packaging & Labels' },
  ])
  eq(
    canonicalCategory('Packaging', approved),
    'Packaging & Labels',
    'canon: approved alias groups',
  )
  eq(
    canonicalCategory('Payroll', approved),
    'Payroll',
    'canon: unrelated label untouched by approval',
  )
  // Undo is modelled by dropping the alias — the ungrouped view returns at once.
  eq(canonicalCategory('Packaging', {}), 'Packaging', 'canon: undo restores ungrouped')
}

/* ---------------- category resolution order ---------------- */
{
  const vendors = new Map([['v1', 'Product Purchases']])
  eq(
    resolveExpenseCategory({ expenseCategory: 'Fuel', vendorId: 'v1' }, vendors),
    { category: 'Fuel', source: 'transaction' },
    'resolve: transaction overrides vendor',
  )
  eq(
    resolveExpenseCategory({ expenseCategory: '', vendorId: 'v1' }, vendors),
    { category: 'Product Purchases', source: 'vendor' },
    'resolve: falls back to vendor default',
  )
  eq(
    resolveExpenseCategory({ expenseCategory: '', vendorId: null }, vendors),
    { category: UNCATEGORIZED, source: 'none' },
    'resolve: no category at all',
  )
  eq(
    resolveExpenseCategory({ expenseCategory: '   ', vendorId: 'v1' }, vendors),
    { category: 'Product Purchases', source: 'vendor' },
    'resolve: whitespace is not a category',
  )
}

/* ---------------- spend by category ---------------- */
{
  const vendors = new Map([['v1', 'Fuel']])
  const result = summarizeSpendByCategory(
    [
      row({ transactionDate: '2025-06-01', amount: -100, expenseCategory: 'Packaging' }),
      row({ transactionDate: '2025-06-02', amount: -50, expenseCategory: 'Labels & Packaging' }),
      row({ transactionDate: '2025-06-03', amount: -200, vendorId: 'v1' }),
      row({ transactionDate: '2025-06-04', amount: -25 }),
      // Income must never appear in a spend breakdown.
      row({
        transactionDate: '2025-06-05',
        amount: 5000,
        transactionType: 'income',
        expenseCategory: 'Sales Deposit',
      }),
    ],
    vendors,
  )
  eq(result.totalSpend, 375, 'spend: income excluded from total')
  eq(result.categories[0].category, 'Fuel', 'spend: largest first')
  eq(result.categories[0].amount, 200, 'spend: vendor default applied')
  // Without an approval the two packaging spellings report SEPARATELY.
  eq(
    result.categories.find((c) => c.category === 'Packaging & Labels'),
    undefined,
    'spend: no grouped bucket without approval',
  )
  eq(
    result.categories.find((c) => c.category === 'Packaging')?.amount,
    100,
    'spend: raw Packaging reported on its own',
  )
  eq(
    result.categories.find((c) => c.category === 'Labels & Packaging')?.amount,
    50,
    'spend: raw Labels & Packaging reported on its own',
  )
  eq(result.uncategorizedSpend, 25, 'spend: uncategorized tracked')
  eq(Math.round(result.coverage * 100), 93, 'spend: coverage measured in dollars')
}

// Approving the merge groups those same rows — display only, same total spend.
{
  const vendors = new Map([['v1', 'Fuel']])
  const rows = [
    row({ transactionDate: '2025-06-01', amount: -100, expenseCategory: 'Packaging' }),
    row({ transactionDate: '2025-06-02', amount: -50, expenseCategory: 'Labels & Packaging' }),
  ]
  const before = summarizeSpendByCategory(rows, vendors)
  const after = summarizeSpendByCategory(
    rows,
    vendors,
    buildApprovedAliasMap([
      {
        fromCategories: ['Packaging', 'Labels & Packaging'],
        toCategory: 'Packaging & Labels',
      },
    ]),
  )
  eq(before.categories.length, 2, 'spend: ungrouped shows both labels')
  eq(after.categories.length, 1, 'spend: approved merge shows one bucket')
  eq(after.categories[0].category, 'Packaging & Labels', 'spend: grouped under target')
  eq(after.categories[0].amount, 150, 'spend: grouped amount is the sum')
  eq(
    after.categories[0].mergedFrom,
    ['Labels & Packaging', 'Packaging'],
    'spend: merge is disclosed',
  )
  // The dollars never move — grouping is presentational.
  eq(after.totalSpend, before.totalSpend, 'spend: approval does not change total')
}

// The mistyped Sales Deposit expense rows are flagged, not silently edited.
{
  const result = summarizeSpendByCategory(
    [
      row({
        transactionDate: '2025-06-01',
        amount: -3142,
        transactionType: 'expense',
        expenseCategory: 'Sales Deposit',
      }),
    ],
    new Map(),
  )
  eq(result.suspectedMistyped.length, 1, 'spend: mistyped category flagged')
  eq(result.suspectedMistyped[0].category, 'Sales Deposit', 'spend: flags the value')
  eq(result.suspectedMistyped[0].amount, 3142, 'spend: flags the amount')
}

eq(summarizeSpendByCategory([], new Map()).totalSpend, 0, 'spend: empty input')
eq(summarizeSpendByCategory([], new Map()).coverage, 0, 'spend: empty coverage is zero')

/* ---------------- report ---------------- */
console.log(`\ncash-flow-service: ${pass} passed, ${fail} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
