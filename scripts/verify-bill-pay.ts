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
  nextScheduledDueDate,
  buildForecastMovements,
  CLEAR_WINDOW_DAYS,
  ACH_DRAFT_WINDOW_DAYS,
  type ObligationPayment,
  type TxnRow,
} from '../lib/bill-pay-service'
import {
  paymentLabel,
  validatePaymentBasics,
  buildAchReconcileMatches,
  descriptionMatchesVendor,
  amountWithinAchTolerance,
  vendorTokens,
  sumPaidInMonth,
  type AchObligationInput,
  type AchTxnInput,
} from '../lib/bill-pay-shared'
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
  // Written by default, matching the DB column default. Tests that pass
  // `checkNumber: null` mean "a check I wrote but never numbered", which is still a
  // real check — only an explicit `checkWritten: false` means "not written yet".
  checkWritten: true,
  bankAccountId: null,
  status: 'outstanding',
  clearedDate: null,
  clearedTransactionId: null,
  memo: '',
  createdAt: '2026-07-01T00:00:00Z',
  payeeName: '',
  payeeVendorId: null,
  purpose: '',
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

console.log('\nSchedule-anchored next due (self-correcting; the skip-a-month bug)')
// The exact regression: Rent anchored Aug 1, August paid on the 4th. The old
// single-step from a next_due_date that had drifted to Sep 1 produced Oct 1 and
// silently dropped September. Anchored on due_date, the answer is Sep 1.
check(
  'paying the current period rolls to exactly the next one',
  nextScheduledDueDate('2026-08-01', 'Monthly', '2026-08-04'),
  '2026-09-01',
)
check(
  'a never-paid bill is due at its anchor, NOT one interval past it',
  nextScheduledDueDate('2026-08-01', 'Monthly', null),
  '2026-08-01',
)
check(
  'the last paid period drives it, not a drifted stored date (Electric)',
  nextScheduledDueDate('2026-08-28', 'Monthly', '2026-07-28'),
  '2026-08-28',
)
check(
  'several months of backfill land on the first unpaid period, no skips',
  nextScheduledDueDate('2026-01-15', 'Monthly', '2026-07-20'),
  '2026-08-15',
)
check(
  'weekly cadence advances past the paid week only',
  nextScheduledDueDate('2026-07-01', 'Weekly', '2026-07-01'),
  '2026-07-08',
)
ok(
  'the result is always strictly after the paid-through date',
  nextScheduledDueDate('2026-08-28', 'Monthly', '2026-07-28') > '2026-07-28',
)
check('a missing anchor yields no date rather than a guess', nextScheduledDueDate('', 'Monthly', '2026-07-01'), '')

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
  // A settled payment must never be offered again, whatever the caller passes in —
  // confirming it twice would double-count it against cash.
  const s = buildClearingSuggestions(
    [pay({ status: 'cleared', checkNumber: '1001' })],
    [txn({ check_number: '1001' })],
  )
  check('an already-cleared check is never re-suggested', s, [])
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

console.log('\nUnwritten checks (a bill logged before the check is written)')
{
  // The distinction this flag exists for. A check the owner WROTE but never numbered
  // has a real payment date, so amount+date matching is sound. A check that does not
  // exist yet has only an intended date, so the same match could grab an unrelated
  // withdrawal of the same amount.
  const written = buildClearingSuggestions(
    [pay({ checkNumber: null, checkWritten: true, amount: 250 })],
    [txn({ id: 't2', amount: 250, transaction_date: '2026-07-10' })],
  )
  check('a written check with no number still matches on amount+date', written.length, 1)

  const unwritten = buildClearingSuggestions(
    [pay({ checkNumber: null, checkWritten: false, amount: 250, payeeName: 'Gator Joe' })],
    [txn({ id: 't2', amount: 250, transaction_date: '2026-07-10' })],
  )
  check(
    'an unwritten check is never matched on amount alone',
    unwritten.some((s) => s.matchType === 'amount_date'),
    false,
  )
}

{
  // Its date is an intention, so the real debit may legitimately land BEFORE it.
  // Pass 2 would reject that; payee matching must still find it.
  const s = buildClearingSuggestions(
    [
      pay({
        checkNumber: null,
        checkWritten: false,
        paymentDate: '2026-07-10',
        payeeName: 'Gator Joe Exotic Leathers',
        amount: 382,
      }),
    ],
    [
      txn({
        id: 'early',
        amount: 382,
        transaction_date: '2026-07-08',
        description: 'CHECK GATOR JOE EXOTIC LEATHERS',
      }),
    ],
  )
  ok(
    'an unwritten check can still be found by payee when the debit lands early',
    s.length === 0 || s[0]?.matchType === 'vendor_amount',
    `got ${JSON.stringify(s.map((x) => x.matchType))}`,
  )
}

{
  // Without a payee there is nothing to identify it by, so it must be excluded
  // rather than left to match on amount alone.
  const s = buildClearingSuggestions(
    [pay({ checkNumber: null, checkWritten: false, payeeName: '', amount: 100 })],
    [txn({ amount: 100 })],
  )
  check('an unwritten check with no payee is never suggested', s, [])
}

{
  // Recording the number promotes it to written, which is what makes the stronger
  // matching passes apply. Same payment, one field different.
  const before = buildClearingSuggestions(
    [pay({ checkNumber: null, checkWritten: false, payeeName: 'Acme', amount: 500 })],
    [txn({ id: 'b', amount: 500, transaction_date: '2026-07-05' })],
  )
  const after = buildClearingSuggestions(
    [pay({ checkNumber: '1318', checkWritten: true, payeeName: 'Acme', amount: 500 })],
    [txn({ id: 'b', amount: 500, transaction_date: '2026-07-05' })],
  )
  ok(
    'writing the check makes amount+date matching available',
    !before.some((s) => s.matchType === 'amount_date') &&
      after.some((s) => s.matchType === 'amount_date'),
  )
}

console.log('\n"Paid This Month" counts only money that actually left')
{
  const m = '2026-08'
  // The exact bug found on screen: two bills logged as pay-by-check-later showed as
  // $757 "Paid This Month" while simultaneously showing as $757 Outstanding.
  const unwritten = [
    pay({ amount: 375, paymentDate: '2026-08-15', checkNumber: null, checkWritten: false }),
    pay({ amount: 382, paymentDate: '2026-08-15', checkNumber: null, checkWritten: false }),
  ]
  check('unwritten checks are not counted as paid', sumPaidInMonth(unwritten, m), 0)

  check(
    'a written outstanding check IS counted as paid',
    sumPaidInMonth([pay({ amount: 500, paymentDate: '2026-08-04' })], m),
    500,
  )
  check(
    'a cleared payment is counted as paid',
    sumPaidInMonth([pay({ amount: 265, paymentDate: '2026-08-03', status: 'cleared' })], m),
    265,
  )
  check(
    'a void payment is never counted as paid',
    sumPaidInMonth([pay({ amount: 900, paymentDate: '2026-08-02', status: 'void' })], m),
    0,
  )
  check(
    'an ACH draft that has not pulled yet is not counted as paid',
    sumPaidInMonth(
      [pay({ amount: 1200, paymentDate: '2026-08-20', paymentMethod: 'ach', checkNumber: null })],
      m,
    ),
    0,
  )
  check(
    'other months are excluded',
    sumPaidInMonth([pay({ amount: 646, paymentDate: '2026-07-24', status: 'cleared' })], m),
    0,
  )
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
console.log('\nOne-off payments (a check with no scheduled bill behind it)')

{
  // The entire reason one-off entry exists: a check to a supplier who is not one
  // of the recurring obligations must reduce spendable cash exactly like a
  // scheduled one. If it did not, the float number would read optimistically high.
  const oneOff = pay({
    id: 'oo1',
    obligationId: null,
    payeeName: 'Coastal Seed Supply',
    purpose: 'Spring seed order',
    amount: 1_240,
    checkNumber: '1402',
  })
  const scheduled = pay({ id: 's1', obligationId: 'o1', amount: 760 })

  const mixed = deriveOutstandingCash(10_000, [oneOff, scheduled])
  check('a one-off check reduces spendable cash', mixed.outstandingChecks, 2_000)
  check('and both are counted', mixed.outstandingCheckCount, 2)
  check('so spendable cash is right', mixed.cashAvailable, 8_000)

  const onlyOneOff = deriveOutstandingCash(5_000, [oneOff])
  check('a one-off alone still floats', onlyOneOff.outstandingChecks, 1_240)
  check('and reduces cash', onlyOneOff.cashAvailable, 3_760)

  // An ACH one-off never floats, same as a scheduled ACH — status decides, not
  // whether an obligation is attached.
  const achOneOff = pay({
    id: 'oo2',
    obligationId: null,
    payeeName: 'Tractor Repair Co',
    paymentMethod: 'ach',
    status: 'cleared',
    amount: 900,
  })
  check(
    'a cleared one-off ACH does not reduce spendable cash',
    deriveOutstandingCash(5_000, [achOneOff]).cashAvailable,
    5_000,
  )

  // Labelling: a row in a cash ledger must never be anonymous.
  const names = new Map([['o1', 'Rent · 3T XL LLC']])
  check('a scheduled payment is labelled by its bill', paymentLabel(scheduled, names), 'Rent · 3T XL LLC')
  check('a one-off is labelled by its payee', paymentLabel(oneOff, names), 'Coastal Seed Supply')
  check(
    'an unknown obligation still gets a readable label, never a bare id',
    paymentLabel(pay({ obligationId: 'gone' }), names),
    'Scheduled bill',
  )
  check(
    'and a payee-less one-off never renders blank',
    paymentLabel(pay({ obligationId: null, payeeName: '' }), names),
    'One-off payment',
  )

  // A one-off check is matchable to the bank feed on the same terms as any other.
  const suggested = buildClearingSuggestions(
    [oneOff],
    [txn({ id: 't1', check_number: '1402', amount: 1_240, transaction_date: '2026-07-09' })],
  )
  check('a one-off check can be matched by check number', suggested.length, 1)
  check('and is labelled as the strong match type', suggested[0]?.matchType, 'check_number')
}

console.log('\nShared payment validation (one-off held to the same standard)')

{
  const base = { amount: 100, paymentDate: '2026-07-01', paymentMethod: 'check', checkNumber: '1001' }
  ok('a valid check passes', validatePaymentBasics(base) === null)
  ok(
    'a check with no number is rejected',
    validatePaymentBasics({ ...base, checkNumber: '' }) === 'Enter the check number.',
  )
  ok(
    'ACH does not require a check number',
    validatePaymentBasics({ ...base, paymentMethod: 'ach', checkNumber: '' }) === null,
  )
  ok('zero amount is rejected', validatePaymentBasics({ ...base, amount: 0 }) !== null)
  ok('negative amount is rejected', validatePaymentBasics({ ...base, amount: -50 }) !== null)
  ok(
    'a malformed date is rejected',
    validatePaymentBasics({ ...base, paymentDate: '07/01/2026' }) !== null,
  )
  ok(
    'an unknown method is rejected',
    validatePaymentBasics({ ...base, paymentMethod: 'cash' }) !== null,
  )
}

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

console.log('\nPending ACH drafts (a logged Sysco/Quirch invoice awaiting its draft)')

{
  // A logged invoice: ACH, outstanding, identified by payee (no check number).
  const draft = (p: Partial<ObligationPayment> = {}): ObligationPayment =>
    pay({
      obligationId: null,
      paymentMethod: 'ach',
      checkNumber: null,
      payeeName: 'Sysco',
      amount: 5188,
      paymentDate: '2026-07-10',
      ...p,
    })

  {
    const s = buildClearingSuggestions(
      [draft()],
      [txn({ id: 'tq', description: 'SYSCO BROS ACH DEBIT', amount: 5188, transaction_date: '2026-07-12' })],
    )
    check('a pending draft matches its bank debit by vendor + amount', s.length, 1)
    check('and is labelled as a vendor match', s[0]?.matchType, 'vendor_amount')
    check('and carries the payee so a numberless draft is identifiable', s[0]?.payeeName, 'Sysco')
  }

  {
    // The float is the whole point: an unsettled draft must reduce spendable cash
    // exactly like a written check, or the number lies during the 3+ day window.
    const d = deriveOutstandingCash(20_000, [draft({ amount: 7_500 })])
    check('a pending ACH draft reduces spendable cash', d.cashAvailable, 12_500)
    check('and is counted as outstanding', d.outstandingChecks, 7_500)
  }

  {
    // Unlike a check, an ACH may pull EARLIER than the date the owner guessed.
    const s = buildClearingSuggestions(
      [draft({ paymentDate: '2026-07-10' })],
      [txn({ id: 'te', description: 'SYSCO DEBIT', amount: 5188, transaction_date: '2026-07-07' })],
    )
    check('a draft that pulled before the expected date still matches', s.length, 1)
  }

  {
    const far = new Date('2026-07-10T00:00:00')
    far.setDate(far.getDate() + ACH_DRAFT_WINDOW_DAYS + 4)
    const s = buildClearingSuggestions(
      [draft()],
      [txn({ description: 'SYSCO DEBIT', amount: 5188, transaction_date: far.toISOString().slice(0, 10) })],
    )
    check('a debit far outside the draft window is not matched', s, [])
  }

  {
    // Real invoices rarely draft to the penny; a small variance must still match.
    const s = buildClearingSuggestions(
      [draft({ amount: 5000 })],
      [txn({ description: 'SYSCO DEBIT', amount: 5060, transaction_date: '2026-07-11' })],
    )
    check('a small amount variance still matches', s.length, 1)
  }

  {
    const s = buildClearingSuggestions(
      [draft({ amount: 5000 })],
      [txn({ description: 'SYSCO DEBIT', amount: 8900, transaction_date: '2026-07-11' })],
    )
    check('a wildly different amount is not matched', s, [])
  }

  {
    const s = buildClearingSuggestions(
      [draft({ payeeName: 'Quirch Foods' })],
      [txn({ description: 'SYSCO BROS ACH DEBIT', amount: 5188, transaction_date: '2026-07-11' })],
    )
    check('a different vendor is never matched on amount alone', s, [])
  }

  {
    // Without a payee there is no identifier, so matching could only be by amount —
    // precisely the false positive that would clear the wrong weekly draft.
    const s = buildClearingSuggestions(
      [draft({ payeeName: '   ' })],
      [txn({ description: 'ACH DEBIT 5188', amount: 5188, transaction_date: '2026-07-11' })],
    )
    check('a draft with no payee name is never auto-suggested', s, [])
  }

  {
    // Two weekly Sysco invoices in flight, one debit: the exact amount must win it,
    // not whichever near-amount draft happened to be checked first.
    const s = buildClearingSuggestions(
      [
        draft({ id: 'near', amount: 5100, paymentDate: '2026-07-09' }),
        draft({ id: 'exact', amount: 5188, paymentDate: '2026-07-11' }),
      ],
      [txn({ id: 'one', description: 'SYSCO DEBIT', amount: 5188, transaction_date: '2026-07-10' })],
    )
    check('only one draft claims the single debit', s.length, 1)
    check('and the exact-amount draft wins it over the near one', s[0]?.paymentId, 'exact')
  }

  {
    const s = buildClearingSuggestions(
      [draft({ status: 'cleared' })],
      [txn({ description: 'SYSCO DEBIT', amount: 5188, transaction_date: '2026-07-11' })],
    )
    check('an already-cleared draft is never re-suggested', s, [])
  }

  {
    // A settled one-off ACH (recorded after the fact) is cleared, so it is not a
    // pending draft and must not be pulled into the suggestion list.
    const s = buildClearingSuggestions(
      [draft({ id: 'd1' }), pay({ id: 'c1', checkNumber: '1001', amount: 300 })],
      [
        txn({ id: 'tb1', description: 'SYSCO DEBIT', amount: 5188, transaction_date: '2026-07-11' }),
        txn({ id: 'tb2', check_number: '1001', amount: 300, transaction_date: '2026-07-05' }),
      ],
    )
    check('drafts and checks are matched side by side', s.length, 2)
    ok(
      'each keeps its own match kind',
      s.some((x) => x.paymentId === 'd1' && x.matchType === 'vendor_amount') &&
        s.some((x) => x.paymentId === 'c1' && x.matchType === 'check_number'),
    )
  }
}

console.log('\nAutopay/ACH auto-reconcile from the bank feed')

{
  // Fixtures mirror the real farm data: distinct ACH vendors, plus the check-side
  // amount collisions ($200/$500 vs loans, twin $1,500 draws) that MUST be ignored.
  const ach = (over: Partial<AchObligationInput>): AchObligationInput => ({
    id: 'a1',
    obligationName: 'Bill',
    vendorName: 'Vendor',
    amount: 100,
    frequency: 'Monthly',
    nextDueDate: '2026-08-15',
    recurring: true,
    active: true,
    paymentMethod: 'ACH',
    ...over,
  })
  const bank = (over: Partial<AchTxnInput>): AchTxnInput => ({
    id: 't1',
    transaction_date: '2026-07-20',
    amount: 100,
    description: 'SOME DEBIT',
    transaction_type: 'expense',
    ...over,
  })
  const TODAY = '2026-08-02'

  const entergy = ach({ id: 'ent', obligationName: 'Electric', vendorName: 'Entergy', amount: 2200 })
  const gas = ach({ id: 'gas', obligationName: 'Gas', vendorName: 'South Coast Gas', amount: 135 })
  const ally = ach({ id: 'ally', obligationName: 'Van Note', vendorName: 'Ally', amount: 646.32 })
  const pelican = ach({ id: 'pel', obligationName: 'Trash', vendorName: 'Pelican Waste', amount: 265 })

  // --- Tokenization + description matching (the strong key) ---
  check('vendor name reduces to distinctive tokens', vendorTokens('South Coast Gas'), ['SOUTH', 'COAST', 'GAS'])
  // "of" and "AT&T" (after stripping punctuation, "AT" and "T") fall below the
  // 3-char floor, so only "LA" would remain — but it too is under 3, leaving none.
  check('short filler tokens are dropped', vendorTokens('AT&T of LA'), [])
  ok('a bank line containing the vendor matches', descriptionMatchesVendor('Entergy', 'ENTERGY LOUISIAN BANK DRAFT'))
  ok('multi-word vendors need every token present', descriptionMatchesVendor('Pelican Waste', 'Pelican Waste An SIGONFILE'))
  ok('a partial vendor match is rejected', !descriptionMatchesVendor('South Coast Gas', 'COAST HARDWARE STORE'))
  ok('an empty vendor never matches (no amount-only auto-pay)', !descriptionMatchesVendor('', 'ANYTHING 200.00'))

  // --- Amount tolerance calibrated to real seasonal swings ---
  ok('electric drafted low still matches (1,926 vs 2,200)', amountWithinAchTolerance(2200, 1926.03))
  ok('electric drafted high still matches (2,470 vs 2,200)', amountWithinAchTolerance(2200, 2470.18))
  ok('gas small-dollar swing matches (139.85 vs 135)', amountWithinAchTolerance(135, 139.85))
  ok('a wildly wrong amount is rejected', !amountWithinAchTolerance(2200, 400))

  // --- Whole-matcher behavior ---
  {
    const m = buildAchReconcileMatches(
      [entergy, gas, ally, pelican],
      [
        bank({ id: 'be', description: 'ENTERGY LOUISIAN BANK DRAFT', amount: 2193.23, transaction_date: '2026-07-28' }),
        bank({ id: 'bg', description: 'SOUTH COAST GAS BILL PAY', amount: 139.85, transaction_date: '2026-07-22' }),
        bank({ id: 'ba', description: 'ALLY ALLY PAYMT 12345', amount: 646.32, transaction_date: '2026-07-15' }),
        bank({ id: 'bp', description: 'Pelican Waste An SIGONFILE', amount: 265, transaction_date: '2026-07-10' }),
      ],
      [],
      TODAY,
    )
    check('all four distinct ACH bills match their debit', m.length, 4)
    check('the payment is dated on the actual posted date, not the due date', m.find((x) => x.obligationId === 'ent')?.postedDate, '2026-07-28')
    check('and records the actual drafted amount, not the scheduled one', m.find((x) => x.obligationId === 'ent')?.amount, 2193.23)
  }

  // The dangerous case: a $500 loan debit must NOT clear a $500 check-paid bill.
  {
    const billboard = ach({ id: 'bb', obligationName: 'Billboard', vendorName: 'MediaRite', amount: 500, paymentMethod: 'Check' })
    const m = buildAchReconcileMatches(
      [billboard],
      [bank({ id: 'loan', description: 'Loan Payment 998877', amount: 500 })],
      [],
      TODAY,
    )
    ok('a check-paid bill is never auto-reconciled, even on an exact amount', m.length === 0)
  }

  // An ACH bill whose vendor name is absent from every description stays unmatched.
  {
    const m = buildAchReconcileMatches(
      [ach({ id: 'x', vendorName: 'Hidden Vendor', amount: 200 })],
      [bank({ description: 'ACH DEBIT 200.00', amount: 200 })],
      [],
      TODAY,
    )
    ok('amount alone never triggers a match without the vendor name', m.length === 0)
  }

  // Idempotency: a transaction already linked to a payment is not matched again.
  {
    const m = buildAchReconcileMatches(
      [entergy],
      [bank({ id: 'used', description: 'ENTERGY DRAFT', amount: 2200 })],
      ['used'],
      TODAY,
    )
    ok('an already-reconciled bank row is skipped (tap-twice safe)', m.length === 0)
  }

  // One transaction is claimed once, even if two bills could plausibly want it.
  {
    const twinA = ach({ id: 'ta', vendorName: 'Acme', amount: 300 })
    const twinB = ach({ id: 'tb', vendorName: 'Acme', amount: 300 })
    const m = buildAchReconcileMatches(
      [twinA, twinB],
      [bank({ id: 'one', description: 'ACME DEBIT', amount: 300 })],
      [],
      TODAY,
    )
    check('a single debit is claimed by exactly one bill', m.length, 1)
  }

  // A future-dated row and an ancient row are both out of scope.
  {
    const m = buildAchReconcileMatches(
      [entergy],
      [
        bank({ id: 'fut', description: 'ENTERGY DRAFT', amount: 2200, transaction_date: '2026-09-01' }),
        bank({ id: 'old', description: 'ENTERGY DRAFT', amount: 2200, transaction_date: '2026-01-01' }),
      ],
      [],
      TODAY,
    )
    ok('a future-dated or long-past debit is not reconciled', m.length === 0)
  }
}

console.log('\nForecast movements (outstanding payments included, never double-counted)')
{
  const net = (ms: { amount: number }[]) => ms.reduce((s, m) => s + m.amount, 0)

  // An outstanding payment tied to a recurring bill SUPERSEDES that bill's generic
  // scheduled outflow — otherwise the rent would be subtracted twice.
  const noDouble = buildForecastMovements({
    obligations: [
      { id: 'rent', name: 'Rent', amount: 2811, effectiveDueDate: '2026-08-15' },
    ],
    receivables: [],
    payments: [
      { obligationId: 'rent', name: 'Rent', amount: 2811, date: '2026-08-04', status: 'outstanding' },
    ],
  })
  check('a covered obligation is suppressed (one movement, not two)', noDouble.length, 1)
  check('the surviving movement is the real payment, on its real date', noDouble[0].date, '2026-08-04')
  check('rent is counted once, not twice', net(noDouble), -2811)

  // A one-off payment (no obligation behind it) can never collide, so it is always added.
  const oneOff = buildForecastMovements({
    obligations: [{ id: 'rent', name: 'Rent', amount: 2811, effectiveDueDate: '2026-08-15' }],
    receivables: [],
    payments: [
      { obligationId: null, name: 'Sysco', amount: 5026, date: '2026-08-05', status: 'outstanding' },
    ],
  })
  check('a one-off payment and an unrelated obligation both count', oneOff.length, 2)
  check('their outflows sum correctly', net(oneOff), -(2811 + 5026))

  // cleared / void payments never reach the forecast; cleared is already in cash-on-hand.
  const filtered = buildForecastMovements({
    obligations: [],
    receivables: [],
    payments: [
      { obligationId: null, name: 'Paid', amount: 500, date: '2026-08-06', status: 'cleared' },
      { obligationId: null, name: 'Voided', amount: 900, date: '2026-08-06', status: 'void' },
      { obligationId: null, name: 'Live', amount: 200, date: '2026-08-06', status: 'outstanding' },
    ],
  })
  check('only the outstanding payment survives', filtered.length, 1)
  check('cleared and void contribute nothing', net(filtered), -200)

  // Receivables are positive; a net day mixes both directions.
  const mixed = buildForecastMovements({
    obligations: [{ id: 'e', name: 'Electric', amount: 300, effectiveDueDate: '2026-08-28' }],
    receivables: [{ name: 'Big Customer', outstanding: 1000, date: '2026-08-28' }],
    payments: [],
  })
  check('an inflow and an outflow on one day net out', net(mixed), 700)

  // Undated obligations and non-positive receivables are silently skipped.
  const skips = buildForecastMovements({
    obligations: [{ id: 'x', name: 'No date', amount: 999, effectiveDueDate: '' }],
    receivables: [{ name: 'Fully paid', outstanding: 0, date: '2026-08-10' }],
    payments: [],
  })
  check('undated obligation and zero-balance receivable produce nothing', skips.length, 0)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\nverify-bill-pay crashed:', err)
  process.exit(1)
})
