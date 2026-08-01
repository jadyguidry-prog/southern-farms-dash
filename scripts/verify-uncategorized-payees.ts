/**
 * Verifies the uncategorized-payee queue.
 *
 * Run: npx tsx scripts/verify-uncategorized-payees.ts
 *
 * The queue's job is narrow and its boundaries matter more than its totals: it
 * must never claim ownership of payee-less checks (only Check Resolution can
 * identify those), and it must never invent a category.
 */

import {
  buildUncategorizedPayeeGroups,
  summarizeUncategorizedPayees,
  type UncategorizedInputRow,
} from '../lib/uncategorized-payees'

let passed = 0
const failures: string[] = []

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) passed += 1
  else failures.push(`${label}\n    expected: ${b}\n    actual:   ${a}`)
}

function ok(label: string, cond: boolean, detail = '') {
  if (cond) passed += 1
  else failures.push(`${label}${detail ? `\n    ${detail}` : ''}`)
}

function row(
  o: Partial<UncategorizedInputRow> & { id: string; description: string; amount: number },
): UncategorizedInputRow {
  return {
    transactionDate: '2026-06-01',
    transactionType: 'expense',
    reviewStatus: 'reviewed',
    expenseCategory: '',
    ...o,
  }
}

// ---------------------------------------------------------------------------
// The real vendors this screen was built for.
// ---------------------------------------------------------------------------
{
  const rows = [
    row({ id: '1', description: 'BAYOU SIGNS OUTD 1234', amount: -450, transactionDate: '2025-09-05' }),
    row({ id: '2', description: 'BAYOU SIGNS OUTD 1234', amount: -450, transactionDate: '2025-10-05' }),
    row({ id: '3', description: 'BAYOU SIGNS OUTD 9999', amount: -450, transactionDate: '2025-12-05' }),
    row({ id: '4', description: 'COASTAL BROADCAS', amount: -1050, transactionDate: '2025-09-08' }),
  ]
  const groups = buildUncategorizedPayeeGroups(rows)

  eq(groups.length, 2, 'two distinct payees are found')
  // Highest dollars first is what makes the queue worth working top-down.
  eq(groups[0].payee, 'BAYOU SIGNS OUTD 1234', 'largest total sorts first')
  eq(groups[0].total, 1350, 'the three billboard rows are summed')
  eq(groups[0].count, 3, 'and counted')
  eq(
    groups[0].transactionIds,
    ['1', '2', '3'],
    'differing trailing digits still group as one payee',
  )
  eq(groups[0].firstDate, '2025-09-05', 'first date is the earliest row')
  eq(groups[0].lastDate, '2025-12-05', 'last date is the latest row')
  eq(groups[0].months, ['2025-09', '2025-10', '2025-12'], 'months are ascending')

  const summary = summarizeUncategorizedPayees(groups)
  eq(summary, { payeeCount: 2, transactionCount: 4, total: 2400 }, 'summary totals')
}

// ---------------------------------------------------------------------------
// Boundary: payee-less rows belong to Check Resolution, never here.
// ---------------------------------------------------------------------------
{
  const groups = buildUncategorizedPayeeGroups([
    row({ id: 'c1', description: 'CHECK # 1428', amount: -32128 }),
    row({ id: 'c2', description: 'TRANSFER TO SAVINGS', amount: -5000 }),
    row({ id: 'c3', description: 'ACH PAYMENT', amount: -900 }),
    row({ id: 'p1', description: 'TRACTOR SUPPLY 45', amount: -120 }),
  ])
  eq(groups.length, 1, 'only the row with a real payee is queued')
  eq(groups[0].payee, 'TRACTOR SUPPLY 45', 'and it is the named payee')
  ok(
    'a $32,128 check is never offered here, however large',
    !JSON.stringify(groups).includes('32128'),
    JSON.stringify(groups),
  )
}

// ---------------------------------------------------------------------------
// Rows that already have a category are not work.
// ---------------------------------------------------------------------------
{
  const groups = buildUncategorizedPayeeGroups([
    row({ id: '1', description: 'SHELL OIL 88', amount: -60, expenseCategory: 'Fuel' }),
    row({ id: '2', description: 'SHELL OIL 88', amount: -70, expenseCategory: 'Fuel' }),
  ])
  eq(groups.length, 0, 'a fully categorized payee produces no work')
}

// ---------------------------------------------------------------------------
// Sibling evidence: the owner's OWN filing of the same payee, not a guess.
// ---------------------------------------------------------------------------
{
  const groups = buildUncategorizedPayeeGroups([
    row({ id: '1', description: 'TRACTOR SUPPLY 45', amount: -120, expenseCategory: 'Farm Supplies' }),
    row({ id: '2', description: 'TRACTOR SUPPLY 91', amount: -80, expenseCategory: 'Farm Supplies' }),
    row({ id: '3', description: 'TRACTOR SUPPLY 91', amount: -60, expenseCategory: 'Repairs' }),
    // The uncategorized one:
    row({ id: '4', description: 'TRACTOR SUPPLY 12', amount: -200 }),
  ])
  eq(groups.length, 1, 'only the uncategorized row is queued')
  eq(
    groups[0].siblingCategory,
    { category: 'Farm Supplies', count: 2 },
    'the most-used existing category for that payee is offered, with its count',
  )
  eq(groups[0].total, 200, 'categorized siblings are not added to the unfiled total')
}
{
  const groups = buildUncategorizedPayeeGroups([
    row({ id: '1', description: 'NEW VENDOR LLC', amount: -300 }),
  ])
  eq(
    groups[0].siblingCategory,
    null,
    'a payee with no filing history gets no suggestion (never invent one)',
  )
}

// ---------------------------------------------------------------------------
// Only money going out, and never excluded rows.
// ---------------------------------------------------------------------------
{
  const groups = buildUncategorizedPayeeGroups([
    row({ id: '1', description: 'SQUARE PAYOUT', amount: 5000, transactionType: 'income' }),
    row({ id: '2', description: 'IGNORE ME CO', amount: -100, reviewStatus: 'excluded' }),
    row({ id: '3', description: 'REAL VENDOR CO', amount: -100 }),
  ])
  eq(groups.length, 1, 'income and excluded rows are skipped')
  eq(groups[0].payee, 'REAL VENDOR CO', 'only the real spend row remains')
}

// ---------------------------------------------------------------------------
// Label = most common full description.
// ---------------------------------------------------------------------------
{
  const groups = buildUncategorizedPayeeGroups([
    row({ id: '1', description: 'PAYPAL *METAPLATFOR 402', amount: -100 }),
    row({ id: '2', description: 'PAYPAL *METAPLATFOR 402', amount: -100 }),
    row({ id: '3', description: 'PAYPAL *METAPLATFOR 777', amount: -100 }),
  ])
  eq(groups.length, 1, 'one Meta group')
  eq(groups[0].payee, 'PAYPAL *METAPLATFOR 402', 'the most common description labels it')
  eq(groups[0].count, 3, 'all three rows are included')
}

// ---------------------------------------------------------------------------
// Empty input must not throw.
// ---------------------------------------------------------------------------
{
  const groups = buildUncategorizedPayeeGroups([])
  eq(groups, [], 'no rows produces no groups')
  eq(
    summarizeUncategorizedPayees(groups),
    { payeeCount: 0, transactionCount: 0, total: 0 },
    'empty summary is all zeros, not NaN',
  )
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
