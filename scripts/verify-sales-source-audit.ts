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
