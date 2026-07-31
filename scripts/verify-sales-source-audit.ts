/**
 * Checks the sales-source audit rules.
 *
 * Run: npx tsx scripts/verify-sales-source-audit.ts
 *
 * The cases that matter most are the ones that must NOT flag: a manual figure
 * the owner typed, a locked month, and a month where Square genuinely has no
 * data. Over-flagging here would push the owner toward restating revenue that
 * was already right.
 */

import {
  aggregateDailyRetailByMonth,
  auditSalesSources,
  monthKey,
  type MonthAuditInput,
} from '../lib/sales-source-audit'

let pass = 0
let fail = 0

function ok(cond: boolean, label: string) {
  if (cond) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}`)
  }
}

function eq<T>(actual: T, expected: T, label: string) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)})`)
}

/* ---------------- daily aggregation ---------------- */
// `sales_daily` allows two rows for the same date (live API + a CSV of the same
// period). Summing blindly double-counts that day. There are no duplicates in
// the data today, so only a test keeps this correct for the day there are.
const dedup = aggregateDailyRetailByMonth([
  { sale_date: '2026-06-01', source: 'square_api', retail_sales: 100 },
  { sale_date: '2026-06-01', source: 'square_csv', retail_sales: 100 },
  { sale_date: '2026-06-02', source: 'square_api', retail_sales: 50 },
])
eq(dedup.get('2026-06'), 150, 'a duplicated day is counted once, not twice')

// The higher-ranked source must win, regardless of row order.
const ranked = aggregateDailyRetailByMonth([
  { sale_date: '2026-06-01', source: 'square_csv', retail_sales: 80 },
  { sale_date: '2026-06-01', source: 'square_api', retail_sales: 100 },
])
eq(ranked.get('2026-06'), 100, 'the higher-ranked source wins a duplicate date')

// Rows with an unknown source cannot be ranked, so they must not displace a
// known-good figure.
const unknownSrc = aggregateDailyRetailByMonth([
  { sale_date: '2026-06-01', source: 'square_api', retail_sales: 100 },
  { sale_date: '2026-06-01', source: 'mystery_import', retail_sales: 999999 },
])
eq(unknownSrc.get('2026-06'), 100, 'an unrecognised source is ignored')

// Months are split on the real date, so a year boundary cannot merge months.
const spanning = aggregateDailyRetailByMonth([
  { sale_date: '2025-12-31', source: 'square_api', retail_sales: 500 },
  { sale_date: '2026-01-01', source: 'square_api', retail_sales: 700 },
])
eq(spanning.get('2025-12'), 500, 'December stays in December')
eq(spanning.get('2026-01'), 700, 'January stays in January')

eq(aggregateDailyRetailByMonth([]).size, 0, 'no daily rows means no months')
eq(
  aggregateDailyRetailByMonth([{ sale_date: '', source: 'square_api', retail_sales: 9 }]).size,
  0,
  'a row with no date is skipped',
)

/* ---------------- negligible gaps ---------------- */
// The real 2025-10 case: $136.06 on a $48,081.55 month is 0.28%. It must still
// be flagged and still be correctable, but labelled so it does not read like
// the $23,000 discrepancy in 2026-06.
const tinyGap = auditSalesSources([
  {
    month: '2025-10',
    reportedRetail: 48081.55,
    reportedSource: 'calculated',
    squareDailyRetail: 48217.61,
  },
])
eq(tinyGap.downgrades.length, 1, 'a tiny gap is still flagged, not hidden')
eq(tinyGap.rows[0].isNegligible, true, 'a 0.28% gap is marked negligible')
eq(tinyGap.rows[0].differencePercent, 0.28, 'gap percent is computed')
eq(tinyGap.materialNetDifference, 0, 'negligible gaps stay out of the material total')
eq(tinyGap.netDifference, 136.06, 'but they remain in the overall total')
ok(
  tinyGap.rows[0].explanation.includes('barely moves'),
  'the explanation says the correction hardly matters',
)

// A large gap must never be softened.
const bigGap = auditSalesSources([
  {
    month: '2026-06',
    reportedRetail: 47263.0,
    reportedSource: 'calculated',
    squareDailyRetail: 70521.0,
  },
])
eq(bigGap.rows[0].isNegligible, false, 'a 49% gap is not negligible')
eq(bigGap.materialNetDifference, 23258, 'a material gap counts toward the headline')
ok(
  !bigGap.rows[0].explanation.includes('barely moves'),
  'a material gap is not described as harmless',
)

// Exactly at the threshold counts as negligible; just past it does not.
const atEdge = auditSalesSources([
  { month: '2025-01', reportedRetail: 10000, reportedSource: 'calculated', squareDailyRetail: 10100 },
  { month: '2025-02', reportedRetail: 10000, reportedSource: 'calculated', squareDailyRetail: 10101 },
])
eq(atEdge.rows[0].isNegligible, true, 'exactly 1% is negligible')
eq(atEdge.rows[1].isNegligible, false, 'just over 1% is material')

// A month reporting zero cannot be judged as a percentage. Calling that gap
// "0% of the month" would mark a month with no revenue at all as negligible.
const fromZero = auditSalesSources([
  { month: '2025-03', reportedRetail: 0, reportedSource: 'calculated', squareDailyRetail: 5000 },
])
eq(fromZero.rows[0].isNegligible, false, 'a gap against a zero month is never negligible')
eq(fromZero.materialNetDifference, 5000, 'and it counts as material')

/* ---------------- month keys ---------------- */
// This is the case that actually bit: `sales_monthly` mixes "May" with "Jun"
// and "Sep". Matching full names only made 7 of 9 real discrepancies vanish
// from the report without any error being raised.
eq(monthKey(2025, 'May'), '2025-05', 'full name resolves')
eq(monthKey(2025, 'Jun'), '2025-06', 'abbreviated Jun resolves')
eq(monthKey(2025, 'Sep'), '2025-09', 'abbreviated Sep resolves')
eq(monthKey(2025, 'september'), '2025-09', 'lowercase full name resolves')
eq(monthKey(2025, '  Dec  '), '2025-12', 'surrounding whitespace is ignored')
eq(monthKey(2026, 'April'), '2026-04', 'single-digit months are zero-padded')
// Unrecognised input must return null, never a guessed month.
eq(monthKey(2025, 'Smarch'), null, 'an unknown month name is rejected')
eq(monthKey(2025, ''), null, 'an empty month name is rejected')
eq(monthKey(2025, 'Ju'), null, 'an ambiguous two-letter stub is rejected')
eq(monthKey(0, 'May'), null, 'a missing year is rejected')

/* ---------------- the real defect ---------------- */
// A bank-derived estimate reported while Square has its own records.
const downgrade: MonthAuditInput[] = [
  {
    month: '2026-06',
    reportedRetail: 47263.17,
    reportedSource: 'calculated',
    squareDailyRetail: 70521.14,
  },
]
let audit = auditSalesSources(downgrade)
eq(audit.downgrades.length, 1, 'bank estimate beaten by Square is flagged')
eq(audit.netDifference, 23257.97, 'net difference is the exact shortfall')
ok(
  audit.rows[0].explanation.includes('understates'),
  'explains that a bank deposit understates sales',
)

/* ---------------- must NOT flag ---------------- */
// Manual outranks Square by design: the owner's correction must stand.
audit = auditSalesSources([
  {
    month: '2026-06',
    reportedRetail: 50000,
    reportedSource: 'manual',
    squareDailyRetail: 70521.14,
  },
])
eq(audit.downgrades.length, 0, 'a manual figure is never called a downgrade')
ok(
  audit.rows[0].explanation.includes('takes priority'),
  'explains why the manual figure stands',
)

// Square already reported: nothing to change.
audit = auditSalesSources([
  {
    month: '2025-01',
    reportedRetail: 70521.14,
    reportedSource: 'square_api',
    squareDailyRetail: 70521.14,
  },
])
eq(audit.downgrades.length, 0, 'a month already on Square is not flagged')

// Square has nothing, so a bank estimate is the best available.
audit = auditSalesSources([
  {
    month: '2024-03',
    reportedRetail: 12000,
    reportedSource: 'calculated',
    squareDailyRetail: null,
  },
])
eq(audit.downgrades.length, 0, 'no Square data means no downgrade')
ok(
  audit.rows[0].explanation.includes('nothing better'),
  'says plainly that there is nothing better to use',
)

// Sub-cent differences are the same number, not a discrepancy.
audit = auditSalesSources([
  {
    month: '2025-02',
    reportedRetail: 5000.004,
    reportedSource: 'calculated',
    squareDailyRetail: 5000,
  },
])
eq(audit.downgrades.length, 0, 'sub-cent rounding is not a discrepancy')

/* ---------------- locked months ---------------- */
// A locked month is frozen even when Square disagrees. Restating it silently
// would repeat the exact mistake this module exists to catch.
audit = auditSalesSources([
  {
    month: '2025-12',
    reportedRetail: 71217.84,
    reportedSource: 'calculated',
    squareDailyRetail: 83393.8,
    locked: true,
  },
])
eq(audit.downgrades.length, 0, 'a locked month is never auto-corrected')
eq(audit.lockedSkipped.length, 1, 'but the locked month is still surfaced')
eq(audit.netDifference, 0, 'locked months contribute nothing to the total')

/* ---------------- aggregate + ordering ---------------- */
audit = auditSalesSources([
  { month: '2026-06', reportedRetail: 100, reportedSource: 'calculated', squareDailyRetail: 150 },
  { month: '2025-05', reportedRetail: 200, reportedSource: 'calculated', squareDailyRetail: 190 },
  { month: '2025-09', reportedRetail: 300, reportedSource: 'square_api', squareDailyRetail: 300 },
])
eq(audit.downgrades.length, 2, 'counts every affected month')
eq(audit.netDifference, 40, 'nets an overstated month against an understated one')
eq(audit.rows[0].month, '2025-05', 'rows are ordered oldest first')

// A month reported too HIGH is still a downgrade: the source is wrong either way.
ok(
  audit.rows.find((r) => r.month === '2025-05')?.difference === -10,
  'an overstated month reports a negative difference',
)

/* ---------------- degenerate input ---------------- */
audit = auditSalesSources([])
eq(audit.downgrades.length, 0, 'no months means no findings')
eq(audit.netDifference, 0, 'no months means no total')

audit = auditSalesSources([
  { month: '2025-01', reportedRetail: null, reportedSource: null, squareDailyRetail: null },
])
eq(audit.downgrades.length, 0, 'a month with no data anywhere is not flagged')

console.log(`\nsales source audit: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
