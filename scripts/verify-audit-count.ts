/**
 * Regression tests for the "Recent changes" row count.
 *
 * The audit log stores one entry per changed FIELD, so a single recategorize of
 * 47 transactions writes 94 entries (`expense_category` + `review_status`).
 * Counting entries instead of transactions reported that correction as
 * "94 rows" — telling the owner a correct change had touched twice as much data
 * as it really did. These tests pin the count to distinct transactions.
 *
 * The reducer under test is duplicated here rather than imported because
 * `category-review-service.ts` reaches for a request-scoped Supabase client at
 * module load, which a plain script has no way to provide.
 */

type Raw = {
  bulk_action_id: string | null
  transaction_id: string | null
  action: string | null
  field: string | null
  previous_value: string | null
  new_value: string | null
  created_at: string | null
  reverted_at: string | null
}

type Entry = {
  bulkActionId: string
  action: string
  field: string
  count: number
  sampleFrom: string | null
  sampleTo: string | null
  createdAt: string
  reverted: boolean
}

/** Mirrors the reducer in getCategoryReviewData. */
function collapse(rows: Raw[]): Entry[] {
  const seenTx = new Map<string, Set<string>>()
  const byBulk = new Map<string, Entry>()
  for (const a of rows) {
    const id = String(a.bulk_action_id)
    const txId = a.transaction_id ? String(a.transaction_id) : `entry:${a.created_at}:${a.field}`
    const existing = byBulk.get(id)
    if (existing) {
      const set = seenTx.get(id)!
      set.add(txId)
      existing.count = set.size
      existing.reverted = existing.reverted && Boolean(a.reverted_at)
      if (String(a.field ?? '') === 'expense_category') {
        existing.field = 'expense_category'
        existing.sampleFrom = a.previous_value ? String(a.previous_value) : null
        existing.sampleTo = a.new_value ? String(a.new_value) : null
      }
    } else {
      seenTx.set(id, new Set([txId]))
      byBulk.set(id, {
        bulkActionId: id,
        action: String(a.action ?? ''),
        field: String(a.field ?? ''),
        count: 1,
        sampleFrom: a.previous_value ? String(a.previous_value) : null,
        sampleTo: a.new_value ? String(a.new_value) : null,
        createdAt: String(a.created_at ?? ''),
        reverted: Boolean(a.reverted_at),
      })
    }
  }
  return [...byBulk.values()]
}

function entry(over: Partial<Raw>): Raw {
  return {
    bulk_action_id: 'bulk-1',
    transaction_id: 'tx-1',
    action: 'recategorize_mistyped',
    field: 'expense_category',
    previous_value: 'Sales Deposit',
    new_value: 'Square — Fees',
    created_at: '2026-07-01T00:00:00Z',
    reverted_at: null,
    ...over,
  }
}

let pass = 0
let fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
  }
}

// --- the exact live defect -------------------------------------------------
// 47 transactions, two fields each = 94 log entries. Must report 47.
const twoFieldRows: Raw[] = []
for (let i = 0; i < 47; i++) {
  twoFieldRows.push(entry({ transaction_id: `tx-${i}`, field: 'expense_category' }))
  twoFieldRows.push(
    entry({
      transaction_id: `tx-${i}`,
      field: 'review_status',
      previous_value: 'needs_review',
      new_value: 'matched',
    }),
  )
}
check('47 transactions x 2 fields reports 47, not 94', collapse(twoFieldRows)[0].count, 47)
check('entry count really was double', twoFieldRows.length, 94)

// A third field on the same rows must still report 47.
const threeField = [...twoFieldRows]
for (let i = 0; i < 47; i++) {
  threeField.push(entry({ transaction_id: `tx-${i}`, field: 'vendor_id' }))
}
check('three fields per row still reports 47', collapse(threeField)[0].count, 47)

// --- basics ---------------------------------------------------------------
check('single entry counts once', collapse([entry({})])[0].count, 1)
check('empty input yields no actions', collapse([]).length, 0)
check(
  'two distinct transactions count as two',
  collapse([entry({ transaction_id: 'a' }), entry({ transaction_id: 'b' })])[0].count,
  2,
)
check(
  'duplicate entries for one transaction count once',
  collapse([entry({ transaction_id: 'a' }), entry({ transaction_id: 'a' })])[0].count,
  1,
)

// --- separate bulk actions stay separate ----------------------------------
const twoActions = collapse([
  entry({ bulk_action_id: 'b1', transaction_id: 'a' }),
  entry({ bulk_action_id: 'b1', transaction_id: 'b' }),
  entry({ bulk_action_id: 'b2', transaction_id: 'c' }),
])
check('two bulk actions produce two entries', twoActions.length, 2)
check('first action count', twoActions.find((e) => e.bulkActionId === 'b1')!.count, 2)
check('second action count', twoActions.find((e) => e.bulkActionId === 'b2')!.count, 1)

// A transaction touched by two different actions counts in each.
const shared = collapse([
  entry({ bulk_action_id: 'b1', transaction_id: 'same' }),
  entry({ bulk_action_id: 'b2', transaction_id: 'same' }),
])
check('same transaction in two actions counts once each', [shared[0].count, shared[1].count], [1, 1])

// --- reverted flag --------------------------------------------------------
check(
  'fully reverted action reads as reverted',
  collapse([
    entry({ transaction_id: 'a', reverted_at: '2026-07-02T00:00:00Z' }),
    entry({ transaction_id: 'b', reverted_at: '2026-07-02T00:00:00Z' }),
  ])[0].reverted,
  true,
)
check(
  'partially reverted action is NOT reverted',
  collapse([
    entry({ transaction_id: 'a', reverted_at: '2026-07-02T00:00:00Z' }),
    entry({ transaction_id: 'b', reverted_at: null }),
  ])[0].reverted,
  false,
)

// --- label prefers the category change over review_status bookkeeping -----
const statusFirst = collapse([
  entry({
    transaction_id: 'a',
    field: 'review_status',
    previous_value: 'needs_review',
    new_value: 'matched',
  }),
  entry({
    transaction_id: 'a',
    field: 'expense_category',
    previous_value: 'Sales Deposit',
    new_value: 'Square — Fees',
  }),
])
check('shows the category change even when logged second', statusFirst[0].field, 'expense_category')
check('sampleFrom is the category', statusFirst[0].sampleFrom, 'Sales Deposit')
check('sampleTo is the category', statusFirst[0].sampleTo, 'Square — Fees')

// --- legacy rows without a transaction_id --------------------------------
check(
  'legacy entries with no transaction_id still count',
  collapse([
    entry({ transaction_id: null, field: 'expense_category' }),
    entry({ transaction_id: null, field: 'review_status' }),
  ])[0].count,
  2,
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
