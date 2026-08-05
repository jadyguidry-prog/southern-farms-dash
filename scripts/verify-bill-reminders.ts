/**
 * Tests for the pure bill-reminder engine.
 *
 * The behaviours that matter most and are easiest to get wrong:
 *  - a self-scheduled bill is NEVER called overdue (no vendor deadline exists)
 *  - last month's payment must not silence this month's reminder
 *  - a stale check is flagged but NEVER dropped from what is owed
 */

import {
  buildBillReminders,
  describeReminder,
  type BillReminderInput,
  type UnclearedCheckInput,
} from '../lib/bill-reminders'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
  } else {
    fail++
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function check(name: string, actual: unknown, expected: unknown) {
  ok(name, actual === expected, `expected ${String(expected)}, got ${String(actual)}`)
}

const TODAY = '2026-08-05'

function bill(over: Partial<BillReminderInput> = {}): BillReminderInput {
  return {
    id: over.id ?? 'b1',
    label: over.label ?? 'Vendor',
    amount: over.amount ?? 500,
    dueDate: over.dueDate ?? '2026-08-06',
    selfScheduled: over.selfScheduled ?? false,
    lastPaymentDate: over.lastPaymentDate ?? null,
    cycleStart: over.cycleStart ?? null,
  }
}

function run(
  bills: BillReminderInput[],
  unclearedChecks: UnclearedCheckInput[] = [],
  leadDays = 3,
  staleCheckAfterDays = 35,
) {
  return buildBillReminders({
    bills,
    unclearedChecks,
    today: TODAY,
    leadDays,
    staleCheckAfterDays,
  })
}

// ---------------------------------------------------------------------------
// A self-scheduled bill can never be overdue.
// ---------------------------------------------------------------------------
{
  // MediaRite's real shape: no due date on the invoice, paid when the owner chooses.
  const r = run([
    bill({ label: 'MediaRite', dueDate: '2026-08-01', selfScheduled: true }),
  ])
  check('a self-scheduled past date is not overdue', r.due[0]?.urgency, 'unpaid-planned')
  ok(
    'and is never described as late',
    !/overdue|past due|late/i.test(describeReminder(r.due[0]!)),
    describeReminder(r.due[0]!),
  )
  ok('but it still appears, because it needs paying', r.due.length === 1)

  // The identical date WITH a vendor deadline is a different fact and must say so.
  const v = run([bill({ label: 'Entergy', dueDate: '2026-08-01' })])
  check('the same date with a vendor due date IS overdue', v.due[0]?.urgency, 'overdue')
  check('and states how late it is', describeReminder(v.due[0]!), '4 days past due')
}

// ---------------------------------------------------------------------------
// Lead time is honoured exactly, and is owner-set rather than assumed.
// ---------------------------------------------------------------------------
{
  const r = run([
    bill({ id: 'in3', dueDate: '2026-08-08' }), // exactly at the 3-day lead
    bill({ id: 'in4', dueDate: '2026-08-09' }), // one day beyond
    bill({ id: 'today', dueDate: TODAY }),
  ])
  const ids = r.due.map((d) => d.id)
  ok('a bill at the lead boundary reminds', ids.includes('in3'))
  ok('a bill beyond the lead does not', !ids.includes('in4'))
  ok('and is retained as upcoming instead', r.upcoming.some((u) => u.id === 'in4'))
  check('a bill due today is due-today', r.due.find((d) => d.id === 'today')?.urgency, 'due-today')

  // A longer lead must pull the far bill in — proves the value is actually applied.
  const wide = run(
    [bill({ id: 'in4', dueDate: '2026-08-09' })],
    [],
    7,
  )
  ok('raising the lead time pulls it in', wide.due.some((d) => d.id === 'in4'))
}

// ---------------------------------------------------------------------------
// Settled bills are suppressed — but only by a payment in the CURRENT cycle.
// ---------------------------------------------------------------------------
{
  const paid = run([
    bill({ dueDate: '2026-08-06', cycleStart: '2026-08-01', lastPaymentDate: '2026-08-02' }),
  ])
  check('a bill paid this cycle does not remind', paid.due.length, 0)

  // The trap: a monthly bill paid LAST month must still remind this month. Treating any
  // payment as settlement would hide every recurring bill after its first payment.
  const stale = run([
    bill({ dueDate: '2026-08-06', cycleStart: '2026-08-01', lastPaymentDate: '2026-07-02' }),
  ])
  check("last month's payment does not settle this month", stale.due.length, 1)

  // A one-off has no cycle: any recorded payment settles it.
  const oneOff = run([
    bill({ dueDate: '2026-08-06', cycleStart: null, lastPaymentDate: '2026-07-02' }),
  ])
  check('a one-off is settled by any payment', oneOff.due.length, 0)
}

// ---------------------------------------------------------------------------
// Stale checks: flagged, never removed from what is owed.
// ---------------------------------------------------------------------------
{
  const checks: UnclearedCheckInput[] = [
    { checkNumber: '1001', payee: 'Old Vendor', amount: 2_000, paymentDate: '2026-06-01' },
    { checkNumber: '1002', payee: 'Recent', amount: 900, paymentDate: '2026-08-01' },
  ]
  const r = run([], checks)
  check('only the long-outstanding check is flagged', r.staleChecks.length, 1)
  check('and it is the right one', r.staleChecks[0]?.checkNumber, '1001')
  check('with its true age', r.staleChecks[0]?.daysOutstanding, 65)

  // The owner was explicit: flagged checks must STILL count as owed. This engine only
  // flags, so it must never be the thing that drops one — assert the input is untouched.
  ok(
    'flagging does not remove it from the checks it was given',
    checks.length === 2 && checks.some((c) => c.checkNumber === '1001'),
  )

  // Boundary: exactly at the threshold is not yet stale (strictly greater).
  const atEdge = run(
    [],
    [{ checkNumber: '1', payee: 'Edge', amount: 10, paymentDate: '2026-07-01' }],
    3,
    35,
  )
  check('a check exactly at the threshold is not stale', atEdge.staleChecks.length, 0)
}

// ---------------------------------------------------------------------------
// Ordering and totals.
// ---------------------------------------------------------------------------
{
  const r = run([
    bill({ id: 'soon', dueDate: '2026-08-07', amount: 100 }),
    bill({ id: 'late', dueDate: '2026-08-01', amount: 200 }),
    bill({ id: 'plan', dueDate: '2026-08-02', amount: 300, selfScheduled: true }),
    bill({ id: 'today', dueDate: TODAY, amount: 400 }),
  ])
  check('overdue sorts first', r.due[0]?.id, 'late')
  check('then due today', r.due[1]?.id, 'today')
  check('then unpaid plans', r.due[2]?.id, 'plan')
  check('then due soon', r.due[3]?.id, 'soon')
  check('the total covers every actionable bill', r.dueTotal, 1_000)
}

// ---------------------------------------------------------------------------
// A bill with no date cannot be scheduled, and must not be invented.
// ---------------------------------------------------------------------------
{
  const r = run([bill({ dueDate: '' })])
  check('an undated bill produces no reminder', r.due.length, 0)
  check('and is not silently added to upcoming', r.upcoming.length, 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
