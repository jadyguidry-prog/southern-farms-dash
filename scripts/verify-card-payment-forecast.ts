/**
 * Checks for `planCardPayments` — the rule that puts a card payoff on a DATE.
 *
 * The failure this guards against is a forecast that looks healthier than reality:
 * a large payoff that is silently dropped, dated into the past where the projection
 * never looks, or invented from a balance nobody recorded.
 */

import { planCardPayments } from '../lib/card-activity'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const TODAY = '2026-08-03'

// ---------------------------------------------------------------------------
// The live case: real card, real balance, due date ahead of today.
// ---------------------------------------------------------------------------
{
  const r = planCardPayments(
    [
      {
        accountName: 'American Express ending 0-73009',
        closedAt: null,
        balanceOwed: 9948.13,
        statementDueDate: '2026-08-18',
      },
    ],
    TODAY,
  )
  check('live card produces one payment', r.length === 1, `got ${r.length}`)
  check('live card uses full balance', r[0]?.amount === 9948.13, String(r[0]?.amount))
  check('live card keeps confirmed date', r[0]?.dueDate === '2026-08-18', r[0]?.dueDate)
  check('live card date not flagged estimated', r[0]?.isEstimatedDate === false)
  check('live card not blocked', r[0]?.blockedReason === null)
}

// ---------------------------------------------------------------------------
// Null balance must NOT be forecast as $0. "Not recorded" is not "paid off".
// ---------------------------------------------------------------------------
{
  const r = planCardPayments(
    [
      {
        accountName: 'Card A',
        closedAt: null,
        balanceOwed: null,
        statementDueDate: '2026-08-18',
      },
    ],
    TODAY,
  )
  check('null balance is reported, not dropped', r.length === 1, `got ${r.length}`)
  check(
    'null balance is blocked with a reason',
    r[0]?.blockedReason === 'balance not recorded',
    String(r[0]?.blockedReason),
  )
}

// ---------------------------------------------------------------------------
// A genuine confirmed zero IS nothing to forecast — the inverse of the above.
// ---------------------------------------------------------------------------
{
  const r = planCardPayments(
    [{ accountName: 'Paid off', closedAt: null, balanceOwed: 0, statementDueDate: '2026-08-18' }],
    TODAY,
  )
  check('confirmed $0 produces no payment', r.length === 0, `got ${r.length}`)
}

// ---------------------------------------------------------------------------
// Closed cards are never forecast, even carrying a balance.
// ---------------------------------------------------------------------------
{
  const r = planCardPayments(
    [
      {
        accountName: 'Retired 0-72001',
        closedAt: '2025-12-27',
        balanceOwed: 5000,
        statementDueDate: '2026-08-18',
      },
    ],
    TODAY,
  )
  check('closed card is not forecast', r.length === 0, `got ${r.length}`)
}

// ---------------------------------------------------------------------------
// Missing due date must surface as a stated gap, not a rosier forecast.
// ---------------------------------------------------------------------------
{
  const r = planCardPayments(
    [{ accountName: 'Card B', closedAt: null, balanceOwed: 4000, statementDueDate: null }],
    TODAY,
  )
  check('missing due date is reported', r.length === 1)
  check(
    'missing due date is blocked with a reason',
    r[0]?.blockedReason === 'no statement due date recorded',
    String(r[0]?.blockedReason),
  )
  check('blocked entry keeps the amount for messaging', r[0]?.amount === 4000)
}

// ---------------------------------------------------------------------------
// A PAST due date must roll forward. Left in the past, the projection never sees
// it and the cliff disappears the day after it is paid.
// ---------------------------------------------------------------------------
{
  const r = planCardPayments(
    [{ accountName: 'Card C', closedAt: null, balanceOwed: 1000, statementDueDate: '2026-07-18' }],
    TODAY, // 2026-08-03; the 18th is still ahead this month
  )
  check('past due date rolls to this month', r[0]?.dueDate === '2026-08-18', r[0]?.dueDate)
  check('rolled date is flagged estimated', r[0]?.isEstimatedDate === true)
}

{
  // Day-of-month already passed this month -> next month.
  const r = planCardPayments(
    [{ accountName: 'Card D', closedAt: null, balanceOwed: 1000, statementDueDate: '2026-06-01' }],
    '2026-08-15',
  )
  check('passed day-of-month rolls to next month', r[0]?.dueDate === '2026-09-01', r[0]?.dueDate)
}

{
  // Year boundary.
  const r = planCardPayments(
    [{ accountName: 'Card E', closedAt: null, balanceOwed: 500, statementDueDate: '2026-01-05' }],
    '2026-12-20',
  )
  check('rolls across the year boundary', r[0]?.dueDate === '2027-01-05', r[0]?.dueDate)
}

{
  // 31st in a 30-day month must clamp, not overflow into the next month.
  const r = planCardPayments(
    [{ accountName: 'Card F', closedAt: null, balanceOwed: 500, statementDueDate: '2026-01-31' }],
    '2026-04-05',
  )
  check('31st clamps to end of a 30-day month', r[0]?.dueDate === '2026-04-30', r[0]?.dueDate)
}

{
  // February, non-leap year.
  const r = planCardPayments(
    [{ accountName: 'Card G', closedAt: null, balanceOwed: 500, statementDueDate: '2026-01-31' }],
    '2026-02-01',
  )
  check('31st clamps to Feb 28 in 2026', r[0]?.dueDate === '2026-02-28', r[0]?.dueDate)
}

// ---------------------------------------------------------------------------
// Due date exactly today is still owed today, not rolled a month away.
// ---------------------------------------------------------------------------
{
  const r = planCardPayments(
    [{ accountName: 'Card H', closedAt: null, balanceOwed: 700, statementDueDate: TODAY }],
    TODAY,
  )
  check('due today stays today', r[0]?.dueDate === TODAY, r[0]?.dueDate)
  check('due today is not estimated', r[0]?.isEstimatedDate === false)
}

// ---------------------------------------------------------------------------
// Multiple cards: each is independent, and a blocked one must not suppress a
// good one. Netting or dropping is how real exposure gets understated.
// ---------------------------------------------------------------------------
{
  const r = planCardPayments(
    [
      { accountName: 'Good', closedAt: null, balanceOwed: 9948.13, statementDueDate: '2026-08-18' },
      { accountName: 'Blocked', closedAt: null, balanceOwed: null, statementDueDate: null },
      { accountName: 'Closed', closedAt: '2025-12-27', balanceOwed: 100, statementDueDate: null },
    ],
    TODAY,
  )
  check('two entries (closed excluded)', r.length === 2, `got ${r.length}`)
  const good = r.find((x) => x.accountName === 'Good')
  const blocked = r.find((x) => x.accountName === 'Blocked')
  check('good card still forecast alongside a blocked one', good?.blockedReason === null)
  check('good card amount intact', good?.amount === 9948.13)
  check('blocked card still reported', blocked?.blockedReason !== null)
  check(
    'no netting between cards',
    r.filter((x) => x.blockedReason === null).reduce((s, x) => s + x.amount, 0) === 9948.13,
  )
}

// ---------------------------------------------------------------------------
// Empty input is empty output, not a crash or a phantom payment.
// ---------------------------------------------------------------------------
{
  check('no cards -> no payments', planCardPayments([], TODAY).length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
