// Pure tests for the bank-check -> bill matcher. No database, no clock.
//
// The cases that matter most here are the ones drawn from the real ledger: the two
// $1,500 Owner Draw bills that amount alone cannot tell apart, and the Sysco amounts
// that sit inside each other's loose tolerance band.

import {
  classifyClearCandidates,
  checkNumberOf,
  cents,
  describeAutoClearResult,
  type AutoClearObligation,
  type AutoClearPayment,
  type AutoClearTxn,
} from '../lib/obligation-auto-clear'

let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string) {
  console.log(`\n== ${title} ==`)
}

const TODAY = '2026-08-16'
const OPTS = { orphanReviewDays: 60, clearWindowDays: 120 }

function ob(over: Partial<AutoClearObligation> = {}): AutoClearObligation {
  return {
    id: 'o1',
    obligationName: 'Test Bill',
    vendorName: 'Test Vendor',
    amount: 100,
    status: 'Pending',
    active: true,
    paymentMethod: 'Check',
    ...over,
  }
}

function pay(over: Partial<AutoClearPayment> = {}): AutoClearPayment {
  return {
    id: 'p1',
    obligationId: 'o1',
    status: 'outstanding',
    checkNumber: '1670',
    amount: 100,
    paymentDate: '2026-08-05',
    payee: 'Test Vendor',
    ...over,
  }
}

function txn(over: Partial<AutoClearTxn> = {}): AutoClearTxn {
  return {
    id: 't1',
    transaction_date: '2026-08-10',
    amount: 100,
    description: 'CHECK 1670',
    check_number: null,
    transaction_type: 'expense',
    ...over,
  }
}

// ---------------------------------------------------------------------------
section('Check number extraction')

check('reads the dedicated column', checkNumberOf({ check_number: '1670' }) === '1670')
check('parses "CHECK 1670"', checkNumberOf({ description: 'CHECK 1670' }) === '1670')
check('parses "CHK #1670"', checkNumberOf({ description: 'CHK #1670' }) === '1670')
check('strips leading zeros so 01670 == 1670', checkNumberOf({ check_number: '01670' }) === '1670')
check(
  'column wins over description',
  checkNumberOf({ check_number: '1670', description: 'CHECK 9999' }) === '1670',
)
// A bare number is far more likely an invoice or account number. Treating one as a
// check number would invent a unique identifier that does not exist.
check('a bare number is NOT a check number', checkNumberOf({ description: 'ACH 4455 SYSCO' }) === null)
check('no number at all', checkNumberOf({ description: 'DEBIT CARD PURCHASE' }) === null)

// ---------------------------------------------------------------------------
section('Money compares in integer cents')

// A stored 5025.7 can read back as 5025.7000000000003. If that defeated the exact-amount
// tier, certain matches would silently fall into the review queue and look like caution.
check('float noise does not break equality', cents(5025.7) === cents(5025.7000000000003))
check('a real one-cent difference survives', cents(100.0) !== cents(100.01))

// ---------------------------------------------------------------------------
section('Tier 1: check number + exact amount clears automatically')

{
  const r = classifyClearCandidates([ob()], [pay()], [txn()], [], TODAY, OPTS)
  check('one automatic clear', r.autoClear.length === 1, JSON.stringify(r.autoClear))
  check('nothing sent to review', r.review.length === 0)
  check('links the right payment', r.autoClear[0]?.paymentId === 'p1')
  check('links the right bank row', r.autoClear[0]?.transactionId === 't1')
  check('clears on the posted date, not today', r.autoClear[0]?.postedDate === '2026-08-10')
  check('carries the bill name for the audit', r.autoClear[0]?.label === 'Test Bill')
}

{
  // The number is the identifier; a different payee spelling must not block it.
  const r = classifyClearCandidates(
    [ob()],
    [pay({ payee: 'Someone Else' })],
    [txn({ check_number: '1670', description: 'CHECK PAID' })],
    [],
    TODAY,
    OPTS,
  )
  check('clears from the check_number column too', r.autoClear.length === 1)
}

// ---------------------------------------------------------------------------
section('Tier 2: number matches, amount differs -> review, never written')

{
  const r = classifyClearCandidates([ob()], [pay({ amount: 500 })], [txn({ amount: 520 })], [], TODAY, OPTS)
  check('not auto-cleared', r.autoClear.length === 0)
  check('one review item', r.review.length === 1)
  check('reason is the amount', r.review[0]?.reason === 'amount_mismatch')
  check('keeps the payment id so it can be resolved', r.review[0]?.paymentId === 'p1')
  check('reports both figures', r.review[0]?.recordedAmount === 500 && r.review[0]?.bankAmount === 520)
  check(
    'explanation names both amounts in plain English',
    /\$520\.00/.test(r.review[0]?.explanation ?? '') && /\$500\.00/.test(r.review[0]?.explanation ?? ''),
  )
}

// ---------------------------------------------------------------------------
section('The real Owner Draw tie: two bills at exactly $1,500')

{
  // Both draws are $1,500.00. Amount cannot say which one a $1,500 check paid.
  const obligations = [
    ob({ id: 'draw-jady', obligationName: 'Owner Draw - Jady', amount: 1500 }),
    ob({ id: 'draw-trent', obligationName: 'Owner Draw - Trent', amount: 1500 }),
  ]
  const r = classifyClearCandidates(
    obligations,
    [],
    [txn({ id: 't-draw', amount: 1500, description: 'CHECK 1692' })],
    [],
    TODAY,
    OPTS,
  )
  check('never auto-cleared', r.autoClear.length === 0)
  check('sent to review as ambiguous', r.review[0]?.reason === 'ambiguous_amount')
  check(
    'offers BOTH bills rather than picking one',
    r.review[0]?.candidateObligationIds.length === 2,
    JSON.stringify(r.review[0]?.candidateObligationIds),
  )
  check(
    'explanation says why it cannot decide',
    /more than one bill/i.test(r.review[0]?.explanation ?? ''),
  )
}

{
  // Same trap from the other direction: one bill, but two identical checks in the window.
  // Clearing the bill from either one would be a coin flip.
  const r = classifyClearCandidates(
    [ob({ id: 'rent', obligationName: 'Rent', amount: 2811 })],
    [],
    [
      txn({ id: 'c1', amount: 2811, description: 'CHECK 1667', transaction_date: '2026-08-05' }),
      txn({ id: 'c2', amount: 2811, description: 'CHECK 1753', transaction_date: '2026-08-12' }),
    ],
    [],
    TODAY,
    OPTS,
  )
  check('two identical checks -> no automatic clear', r.autoClear.length === 0)
  check('both surface for review', r.review.length === 2)
  check(
    'both flagged ambiguous, not silently assigned',
    r.review.every((x) => x.reason === 'ambiguous_amount'),
  )
}

// ---------------------------------------------------------------------------
section('Tier 3: unrecorded payment (the gap the old engine could not cover)')

{
  // A bill with NO payment row can never be matched by buildClearingSuggestions,
  // which only inspects outstanding payments. This is the case the owner hit.
  const r = classifyClearCandidates(
    [ob({ id: 'quirch', obligationName: 'Quirch Foods', amount: 3795.33 })],
    [],
    [txn({ id: 't-q', amount: 3795.33, description: 'CHECK 1669' })],
    [],
    TODAY,
    OPTS,
  )
  check('surfaces for review', r.review.length === 1)
  check('reason is unrecorded payment', r.review[0]?.reason === 'possible_unrecorded_payment')
  check('proposes the bill', r.review[0]?.candidateObligationIds[0] === 'quirch')
  check('still not written automatically', r.autoClear.length === 0)
}

{
  // A bill already marked Paid is finished. Re-clearing it would double-count.
  const r = classifyClearCandidates(
    [ob({ id: 'done', obligationName: 'Already Paid', amount: 630.3, status: 'Paid' })],
    [],
    [txn({ id: 't-done', amount: 630.3, description: 'CHECK 1696' })],
    [],
    TODAY,
    OPTS,
  )
  check('a Paid bill is never proposed', r.review[0]?.reason !== 'possible_unrecorded_payment')
  check('and never auto-cleared', r.autoClear.length === 0)
}

// ---------------------------------------------------------------------------
section('Tier 4: orphan checks, bounded to the review window')

{
  const r = classifyClearCandidates(
    [],
    [],
    [txn({ id: 't-orphan', amount: 77.5, description: 'CHECK 1700', transaction_date: '2026-08-01' })],
    [],
    TODAY,
    OPTS,
  )
  check('a recent unmatched check is surfaced', r.review.length === 1)
  check('reason is unrecognized', r.review[0]?.reason === 'unrecognized_check')
}

{
  // 198 such checks exist back to May 2025. Surfacing them all would bury the few
  // that matter under settled history.
  const r = classifyClearCandidates(
    [],
    [],
    [txn({ id: 't-old', amount: 77.5, description: 'CHECK 1200', transaction_date: '2026-01-15' })],
    [],
    TODAY,
    OPTS,
  )
  check('an old unmatched check stays out of the queue', r.review.length === 0)
}

// ---------------------------------------------------------------------------
section('Safety invariants')

{
  // The DB unique index on cleared_transaction_id is the backstop; the matcher must
  // not propose the row in the first place.
  const r = classifyClearCandidates([ob()], [pay()], [txn()], ['t1'], TODAY, OPTS)
  check('an already-linked bank row is never reused', r.autoClear.length === 0 && r.review.length === 0)
}

{
  const r = classifyClearCandidates(
    [ob()],
    [pay({ status: 'cleared' }), pay({ id: 'p2', status: 'void', checkNumber: '1670' })],
    [txn()],
    [],
    TODAY,
    OPTS,
  )
  check('cleared and void payments are never re-cleared', r.autoClear.length === 0)
}

{
  // Money coming IN cannot pay a bill, whatever the description says.
  const r = classifyClearCandidates([ob()], [pay()], [txn({ transaction_type: 'income' })], [], TODAY, OPTS)
  check('an inflow row can never clear a bill', r.autoClear.length === 0 && r.review.length === 0)
}

{
  const r = classifyClearCandidates(
    [ob()],
    [pay()],
    [txn({ transaction_date: '2026-09-01' })],
    [],
    TODAY,
    OPTS,
  )
  check('a future-dated row is ignored', r.autoClear.length === 0)
}

{
  // One bank check must not clear two bills.
  const r = classifyClearCandidates(
    [ob({ id: 'a' }), ob({ id: 'b' })],
    [pay({ id: 'pa', obligationId: 'a' }), pay({ id: 'pb', obligationId: 'b', checkNumber: '1670' })],
    [txn()],
    [],
    TODAY,
    OPTS,
  )
  check('a duplicated check number is never auto-cleared', r.autoClear.length === 0)
  check('it is reported as ambiguous instead', r.review[0]?.reason === 'ambiguous_amount')
}

{
  // Running twice over the same data must not clear twice. Simulates the caller
  // recording the first pass's link before re-running, which is what sync does.
  const first = classifyClearCandidates([ob()], [pay()], [txn()], [], TODAY, OPTS)
  const second = classifyClearCandidates(
    [ob()],
    [pay({ status: 'cleared' })],
    [txn()],
    [first.autoClear[0].transactionId],
    TODAY,
    OPTS,
  )
  check('idempotent: the second pass finds nothing', second.autoClear.length === 0)
}

{
  const r = classifyClearCandidates([], [], [], [], TODAY, OPTS)
  check('empty input is not an error', r.autoClear.length === 0 && r.review.length === 0)
  check('and reads as nothing to do', describeAutoClearResult(r) === 'No bank checks needed matching.')
}

// ---------------------------------------------------------------------------
section('Summary line')

{
  const r = classifyClearCandidates([ob()], [pay()], [txn()], [], TODAY, OPTS)
  check('singular reads correctly', /1 bill matched/.test(describeAutoClearResult(r)))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
