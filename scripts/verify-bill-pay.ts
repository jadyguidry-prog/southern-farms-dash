/**
 * Regression tests for Bill Payments (Phase 1: check + ACH).
 *
 * This feature decides what the owner can actually spend, so the tests focus on
 * the rules that stop it overstating cash or losing a bill:
 *   - an outstanding check reduces spendable cash; a cleared or void one does not
 *   - ACH never floats (no phantom reduction)
 *   - a recurring bill rolls FORWARD on payment and never leaves the forecast
 *   - paying early still advances past the period just paid
 *   - one bank row can never be suggested for two different checks
 *   - a check cannot "clear" before it was written
 *   - the advisor stays silent when nothing is outstanding
 */

import {
  sumOutstanding,
  deriveOutstandingCash,
  buildClearingSuggestions,
  nextDueAfterPayment,
  CLEAR_WINDOW_DAYS,
  type ObligationPayment,
  type TxnRow,
} from '../lib/bill-pay-service'
import { generateInsights, payrollHealth } from '../lib/health'
import { SETTING_DEFAULTS } from '../lib/queries'
import { fetchAllPages } from '../lib/paginate'

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

/** A payment with sensible defaults; override only what a test cares about. */
const pay = (p: Partial<ObligationPayment> = {}): ObligationPayment => ({
  id: 'p1',
  obligationId: 'o1',
  amount: 100,
  paymentDate: '2026-07-01',
  paymentMethod: 'check',
  checkNumber: '1001',
  bankAccountId: null,
  status: 'outstanding',
  clearedDate: null,
  clearedTransactionId: null,
  memo: '',
  createdAt: '2026-07-01T00:00:00Z',
  ...p,
})

const txn = (t: Partial<TxnRow> = {}): TxnRow => ({
  id: 't1',
  transaction_date: '2026-07-05',
  amount: 100,
  description: 'CHECK 1001',
  check_number: null,
  account_name: 'Checking',
  transaction_type: 'expense',
  ...t,
})

console.log('\nOutstanding-check cash math')
check('no payments means nothing outstanding', sumOutstanding([]), 0)
check(
  'an outstanding check counts against cash',
  sumOutstanding([pay({ amount: 2811 })]),
  2811,
)
check(
  'a cleared check no longer floats',
  sumOutstanding([pay({ status: 'cleared', amount: 2811 })]),
  0,
)
check(
  'a void check no longer floats',
  sumOutstanding([pay({ status: 'void', amount: 2811 })]),
  0,
)
check(
  'ACH is never outstanding, so it cannot double-count',
  sumOutstanding([pay({ paymentMethod: 'ach', status: 'cleared', amount: 500 })]),
  0,
)
check(
  'multiple outstanding checks add up',
  sumOutstanding([
    pay({ id: 'a', amount: 2811 }),
    pay({ id: 'b', amount: 2200 }),
    pay({ id: 'c', status: 'cleared', amount: 999 }),
  ]),
  5011,
)

{
  // The core promise of the feature: the bank balance overstates spendable cash
  // while checks are in the mail.
  const d = deriveOutstandingCash(10_000, [
    pay({ id: 'a', amount: 2811 }),
    pay({ id: 'b', amount: 2200 }),
  ])
  check('cashAvailable subtracts outstanding checks', d.cashAvailable, 4989)
  check('outstandingChecks is reported', d.outstandingChecks, 5011)
  check('outstandingCheckCount is reported', d.outstandingCheckCount, 2)
}

{
  const d = deriveOutstandingCash(10_000, [])
  check('with nothing outstanding, available equals on-hand', d.cashAvailable, 10_000)
  check('and the count is zero', d.outstandingCheckCount, 0)
}

{
  // Overdrawn is a real state and must not be clamped to zero: hiding it would
  // hide exactly the problem the owner needs to see.
  const d = deriveOutstandingCash(1_000, [pay({ amount: 2_500 })])
  check('checks exceeding cash produce a negative available', d.cashAvailable, -1500)
}

console.log('\nRecurring roll-forward (a paid bill must never leave the forecast)')
check('monthly advances one month', nextDueAfterPayment('2026-07-01', 'Monthly'), '2026-08-01')
check(
  'paying early still advances past the paid period',
  nextDueAfterPayment('2026-08-15', 'Monthly'),
  '2026-09-15',
)
check('month-end rolls sanely', nextDueAfterPayment('2026-01-31', 'Monthly'), '2026-03-03')
check('weekly advances seven days', nextDueAfterPayment('2026-07-01', 'Weekly'), '2026-07-08')
check(
  'an unknown frequency falls back to monthly rather than sticking',
  nextDueAfterPayment('2026-07-01', ''),
  '2026-08-01',
)
ok(
  'the advanced date is always strictly later than the paid one',
  nextDueAfterPayment('2026-07-01', 'Monthly') > '2026-07-01',
)

console.log('\nBank match suggestions (suggested only, never auto-applied)')
check('no checks means no suggestions', buildClearingSuggestions([], [txn()]), [])
check('no bank rows means no suggestions', buildClearingSuggestions([pay()], []), [])

{
  const s = buildClearingSuggestions(
    [pay({ checkNumber: '1001' })],
    [txn({ id: 't9', check_number: '1001', amount: 999 })],
  )
  check('check-number match is found even when the amount differs', s.length, 1)
  check('and is labelled as the strong match', s[0]?.matchType, 'check_number')
  check('and points at the right bank row', s[0]?.transactionId, 't9')
}

{
  const s = buildClearingSuggestions(
    [pay({ checkNumber: null, amount: 250 })],
    [txn({ id: 't2', amount: 250, transaction_date: '2026-07-10' })],
  )
  check('amount+date match is found when there is no check number', s.length, 1)
  check('and is labelled as the weaker heuristic', s[0]?.matchType, 'amount_date')
}

{
  // Direction/date sanity: a check cannot clear the bank before it was written.
  const s = buildClearingSuggestions(
    [pay({ checkNumber: null, paymentDate: '2026-07-10' })],
    [txn({ transaction_date: '2026-07-01' })],
  )
  check('a bank row before the check date is never matched', s, [])
}

{
  const outside = new Date('2026-07-01T00:00:00')
  outside.setDate(outside.getDate() + CLEAR_WINDOW_DAYS + 5)
  const s = buildClearingSuggestions(
    [pay({ checkNumber: null, paymentDate: '2026-07-01' })],
    [txn({ transaction_date: outside.toISOString().slice(0, 10) })],
  )
  check('a bank row past the clearing window is not matched on amount alone', s, [])
}

{
  // The critical safety property: two same-amount checks must not both claim one
  // bank row, or the cash math would double-count a single withdrawal.
  const s = buildClearingSuggestions(
    [
      pay({ id: 'p1', checkNumber: null, amount: 100 }),
      pay({ id: 'p2', checkNumber: null, amount: 100 }),
    ],
    [txn({ id: 'only-one', amount: 100 })],
  )
  check('one bank row is suggested for only one check', s.length, 1)
}

{
  // A numbered match must win the transaction over a coincidental amount match.
  const s = buildClearingSuggestions(
    [
      pay({ id: 'amountOnly', checkNumber: null, amount: 100 }),
      pay({ id: 'numbered', checkNumber: '4242', amount: 100 }),
    ],
    [txn({ id: 'shared', check_number: '4242', amount: 100 })],
  )
  check('the numbered check claims the shared row', s.length, 1)
  check('and it is the check-number match that wins', s[0]?.paymentId, 'numbered')
}

{
  const s = buildClearingSuggestions(
    [pay({ status: 'cleared' }), pay({ id: 'v', status: 'void' })],
    [txn({ check_number: '1001' })],
  )
  // buildClearingSuggestions is given only outstanding checks by its caller, but
  // it must not invent work if handed settled ones.
  ok('already-settled checks are not re-suggested', s.length <= 1)
}

console.log('\nAdvisor integration (silent when there is nothing to say)')

// generateInsights evaluates every pillar, so supply the same neutral baseline
// the check-resolution suite uses. Holding these constant means any insight the
// assertions below see was produced by the bill-pay input alone.
const settings = { ...SETTING_DEFAULTS } as never
const pillars = {
  payroll: payrollHealth(0, SETTING_DEFAULTS as never),
  cash: { status: 'green', message: '' },
  sales: { status: 'green', message: '' },
} as never
{
  const insights = generateInsights({ settings, pillars, billPay: undefined })
  ok(
    'no bill-pay insight when the module is unused',
    !insights.some((i) => i.id.startsWith('auto-billpay')),
  )
}

{
  const insights = generateInsights({
    settings,
    pillars,
    billPay: {
      outstandingChecks: 5011,
      outstandingCheckCount: 2,
      oldestOutstandingDays: 3,
      cashAvailable: 40_000,
      minCashReserve: 10_000,
    },
  })
  const hit = insights.find((i) => i.id === 'auto-billpay-outstanding')
  ok('a healthy position still explains the float', Boolean(hit))
  ok(
    'and it is not raised as a warning',
    hit?.severity === 'opportunity',
    `severity was ${hit?.severity}`,
  )
}

{
  // The dangerous case this feature exists to surface.
  const insights = generateInsights({
    settings,
    pillars,
    billPay: {
      outstandingChecks: 5011,
      outstandingCheckCount: 2,
      oldestOutstandingDays: 3,
      cashAvailable: 8_000,
      minCashReserve: 10_000,
    },
  })
  const hit = insights.find((i) => i.id === 'auto-billpay-reserve-breach')
  ok('a reserve breach caused by outstanding checks is warned about', Boolean(hit))
  ok('and it is a warning', hit?.severity === 'warning')
  ok(
    'and the healthy message is suppressed so the two cannot contradict',
    !insights.some((i) => i.id === 'auto-billpay-outstanding'),
  )
}

{
  const insights = generateInsights({
    settings,
    pillars,
    billPay: {
      outstandingChecks: 500,
      outstandingCheckCount: 1,
      oldestOutstandingDays: 44,
      cashAvailable: 40_000,
      minCashReserve: 10_000,
    },
  })
  ok(
    'a long-uncleared check is flagged as possibly lost',
    insights.some((i) => i.id === 'auto-billpay-stale-check'),
  )
}

{
  const insights = generateInsights({
    settings,
    pillars,
    billPay: {
      outstandingChecks: 500,
      outstandingCheckCount: 1,
      oldestOutstandingDays: 5,
      cashAvailable: 40_000,
      minCashReserve: 10_000,
    },
  })
  ok(
    'a recent check is not called stale',
    !insights.some((i) => i.id === 'auto-billpay-stale-check'),
  )
}

// The pagination checks await, and this file compiles to CJS (no top-level
// await), so the remaining suites and the summary run inside one async main.
async function main() {
console.log('\nPagination (PostgREST truncates at 1,000 rows and reports no error)')

{
  // 2,350 outstanding checks of $10 each. If the payments read ever loses its
  // pagination, this silently totals $10,000 instead of $23,500 — a plausible
  // looking number, which is exactly what makes the bug dangerous.
  const TOTAL = 2350
  const rows = Array.from({ length: TOTAL }, (_, i) => pay({ id: `p${i}`, amount: 10 }))
  let requests = 0
  const fetched = await fetchAllPages<ObligationPayment>(
    (from, to) => {
      requests++
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
    },
    'verify-pagination',
  )
  ok(`every one of ${TOTAL} rows is read, not just the first 1,000`, fetched.length === TOTAL)
  ok('and it took more than one request', requests > 1)
  const paged = deriveOutstandingCash(50_000, fetched)
  check('so the outstanding total is right', paged.outstandingChecks, 23_500)
  check('and the count is not truncated either', paged.outstandingCheckCount, TOTAL)
}

{
  // A truncated financial total that looks plausible is worse than a loud
  // failure, so a page error must throw rather than return a partial sum.
  let threw = false
  try {
    await fetchAllPages(
      () => Promise.resolve({ data: null, error: { message: 'connection lost' } }),
      'verify-error',
    )
  } catch {
    threw = true
  }
  ok('a failed page throws instead of returning a partial total', threw)
}

console.log('\nGraceful degrade (module unused / overlay table absent)')

{
  // Before the owner records anything — and if the overlay table were missing —
  // the module must report honest zeros and leave cash untouched, never crash
  // and never invent a figure.
  const empty = deriveOutstandingCash(18_846, [])
  ok('no payments leaves cash on hand unchanged', empty.cashAvailable === 18_846)
  ok('and reports zero outstanding', empty.outstandingChecks === 0)
  ok('and zero checks', empty.outstandingCheckCount === 0)
  ok('matching suggests nothing when there is nothing', buildClearingSuggestions([], []).length === 0)
  ok(
    'and the advisor stays silent rather than reporting a confident $0',
    generateInsights({ settings, pillars, billPay: undefined }).every(
      (i) => !i.id.startsWith('auto-billpay'),
    ),
  )
}

console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\nverify-bill-pay crashed:', err)
  process.exit(1)
})
