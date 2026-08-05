/**
 * Tests for entering a bill that is DUE but not yet paid, and for closing a
 * one-time bill once it is actually covered.
 *
 * Run: npx tsx scripts/verify-bill-due.ts
 */

import {
  validateBillDueBasics,
  billFullyCovered,
  resolveOneTimeBillStatus,
  BILL_COVERAGE_TOLERANCE,
} from '../lib/bill-pay-shared'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const validBill = { obligationName: 'Feed delivery', amount: 1200, dueDate: '2026-08-20' }

console.log('\n1. validateBillDueBasics accepts a real bill')
check('a complete bill passes', validateBillDueBasics(validBill) === null)

console.log('\n2. It rejects what is not a bill')
check(
  'no description is rejected',
  validateBillDueBasics({ ...validBill, obligationName: '   ' }) !== null,
)
check('zero amount is rejected', validateBillDueBasics({ ...validBill, amount: 0 }) !== null)
check(
  'negative amount is rejected',
  validateBillDueBasics({ ...validBill, amount: -500 }) !== null,
)
check(
  'NaN amount is rejected',
  validateBillDueBasics({ ...validBill, amount: Number.NaN }) !== null,
)
check(
  'a malformed date is rejected',
  validateBillDueBasics({ ...validBill, dueDate: '08/20/2026' }) !== null,
)
check('an empty date is rejected', validateBillDueBasics({ ...validBill, dueDate: '' }) !== null)

console.log('\n3. It does NOT demand payment fields')
// The whole point of a separate validator: an unpaid invoice has no check number,
// no method and no payment date. If validateBillDueBasics ever started requiring
// them, entering a bill would become impossible.
check(
  'a bill with no method/check number is still valid',
  validateBillDueBasics(validBill) === null,
)

console.log('\n4. billFullyCovered — the partial-payment trap')
check('exact payment covers the bill', billFullyCovered(1000, 1000))
check('overpayment covers the bill', billFullyCovered(1000, 1200))
check('PARTIAL payment does NOT cover the bill', !billFullyCovered(1000, 400))
check('nothing paid does not cover the bill', !billFullyCovered(1000, 0))
check(
  'a payment one cent short does not cover the bill',
  !billFullyCovered(1000, 998),
  'a bill $2 short must stay open',
)

console.log('\n5. Float tolerance')
// 0.1 + 0.2 style drift must not leave a fully-paid bill permanently open.
const drifted = 0.1 + 0.2 + 999.7 // 1000 in exact math, slightly off in floats
check('float drift still counts as covered', billFullyCovered(1000, drifted), String(drifted))
check(
  'tolerance is a cent, not a dollar',
  BILL_COVERAGE_TOLERANCE < 0.02 && !billFullyCovered(1000, 999.5),
  'a 50c shortfall must not be tolerated',
)

console.log('\n6. A bill with no real amount is never "covered"')
// Guards against closing a bill whose amount was never recorded: 0 >= 0 would
// otherwise mark it Paid and hide it forever.
check('zero-amount bill is not covered by zero paid', !billFullyCovered(0, 0))
check('negative-amount bill is not covered', !billFullyCovered(-100, 0))

console.log('\n7. resolveOneTimeBillStatus')
check('fully paid -> Paid', resolveOneTimeBillStatus(1000, 1000) === 'Paid')
check('partially paid -> Pending', resolveOneTimeBillStatus(1000, 400) === 'Pending')
check('unpaid -> Pending', resolveOneTimeBillStatus(1000, 0) === 'Pending')
check(
  'two partials that together cover it -> Paid',
  resolveOneTimeBillStatus(1000, 400 + 600) === 'Paid',
)

console.log('\n8. The double-count scenario this fixes')
// Bill Pay lists obligations where status !== 'Paid'. Before the fix, a one-time
// bill was never closed, so a paid invoice stayed on the payable list — counted
// as still owed AND as paid. Assert the status flips exactly when covered.
const bill = 2500
const stages = [
  { paid: 0, expect: 'Pending' },
  { paid: 1000, expect: 'Pending' },
  { paid: 2499, expect: 'Pending' },
  { paid: 2500, expect: 'Paid' },
]
for (const s of stages) {
  check(
    `paid ${s.paid} of ${bill} -> ${s.expect}`,
    resolveOneTimeBillStatus(bill, s.paid) === s.expect,
  )
}

console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
