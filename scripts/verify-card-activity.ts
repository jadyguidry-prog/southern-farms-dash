/**
 * Checks for the card-ACTIVITY engine (ledger side) and balance reconciliation.
 *
 * Every block pins a rule where the wrong choice produces a plausible but wrong
 * number:
 *   - a derived total presented as the balance when the starting point is unknown
 *   - a missing month of card spend going unnoticed because the feed looked "recent"
 *   - a refund treated as a charge (or a payment as spend), inflating either side
 *   - an unconfirmed balance rendered as $0, reading as "paid off"
 *   - a discrepancy explained away with one cause when two are equally possible
 *   - a new ledger type silently dropped from the totals
 *
 * Run: npx tsx scripts/verify-card-activity.ts
 */
import {
  summarizeCardActivity,
  checkCardBalance,
  typicalMonthlyCharges,
  formatOwedAmount,
  type CardLedgerRow,
} from '../lib/card-activity'

let pass = 0
let fail = 0
const failures: string[] = []

function check<T>(label: string, actual: T, expected: T) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    failures.push(`${label}: expected ${e}, got ${a}`)
  }
}
function ok(label: string, cond: boolean, detail = '') {
  if (cond) pass++
  else {
    fail++
    failures.push(detail ? `${label} — ${detail}` : label)
  }
}

// Fixed "today" so results never depend on when the suite runs.
const TODAY = new Date(2026, 7, 3) // 2026-08-03
const AMEX = 'American Express ending 0-73009'

const row = (o: Partial<CardLedgerRow> = {}): CardLedgerRow => ({
  accountName: AMEX,
  transactionDate: '2026-07-01',
  transactionType: 'expense',
  amount: 100,
  ...o,
})

// ---------------------------------------------------------------------------
console.log('\n— Direction of each ledger type —')
{
  // Amounts are stored as positive magnitudes; direction comes from the type.
  const s = summarizeCardActivity(
    [
      row({ transactionType: 'expense', amount: 1000 }),
      row({ transactionType: 'fee', amount: 50 }),
      row({ transactionType: 'payment', amount: 400 }),
      row({ transactionType: 'refund', amount: 100 }),
    ],
    { today: TODAY },
  )
  const a = s.accounts[0]
  check('charges = expense + fee', a.totalCharges, 1050)
  check('payments tracked separately', a.totalPayments, 400)
  check('refunds tracked separately', a.totalRefunds, 100)
  // The whole point: a refund must REDUCE owed, not add to spend.
  check('implied net = charges − payments − refunds', a.impliedNet, 550)
}

// ---------------------------------------------------------------------------
console.log('— A negative amount must not flip a charge into a credit —')
{
  // If an import ever writes a different sign convention, a charge stored as -500
  // must still count as a charge. Trusting the sign would silently subtract it.
  const s = summarizeCardActivity(
    [row({ transactionType: 'expense', amount: -500 })],
    { today: TODAY },
  )
  check('magnitude used, not sign', s.accounts[0].totalCharges, 500)
  check('and it still increases owed', s.accounts[0].impliedNet, 500)
}

// ---------------------------------------------------------------------------
console.log('— A missing month must be detected —')
{
  // This is the live defect: activity recorded through 2026-07-03 while the
  // calendar says 2026-08-03.
  const s = summarizeCardActivity(
    [row({ transactionDate: '2026-07-03' })],
    { today: TODAY },
  )
  const a = s.accounts[0]
  check('last recorded date', a.lastTxnDate, '2026-07-03')
  check('one calendar month behind', a.monthsBehind, 1)
  ok('feed flagged behind', a.feedBehind)
  check('behind count', s.behindCount, 1)
  // Days is reported as context but must NOT be what triggers the alert: 31 days
  // would sit under a 45-day threshold and stay silent through a real missing month.
  check('days since last txn', a.daysSinceLastTxn, 31)
}

// ---------------------------------------------------------------------------
console.log('— Activity in the current month is NOT behind —')
{
  const s = summarizeCardActivity(
    [row({ transactionDate: '2026-08-01' })],
    { today: TODAY },
  )
  check('zero months behind', s.accounts[0].monthsBehind, 0)
  ok('not flagged behind', !s.accounts[0].feedBehind)
  check('behind count', s.behindCount, 0)
}

// ---------------------------------------------------------------------------
console.log('— Months roll up newest-first and per calendar month —')
{
  const s = summarizeCardActivity(
    [
      row({ transactionDate: '2026-05-10', amount: 100 }),
      row({ transactionDate: '2026-05-20', amount: 200 }),
      row({ transactionDate: '2026-06-01', amount: 300 }),
      row({ transactionDate: '2026-07-02', amount: 400 }),
    ],
    { today: TODAY },
  )
  const a = s.accounts[0]
  check('month order is descending', a.months.map((m) => m.monthKey), [
    '2026-07',
    '2026-06',
    '2026-05',
  ])
  check('May charges summed', a.months.find((m) => m.monthKey === '2026-05')?.charges, 300)
  check('May txn count', a.months.find((m) => m.monthKey === '2026-05')?.txnCount, 2)
  check('first recorded date', a.firstTxnDate, '2026-05-10')
}

// ---------------------------------------------------------------------------
console.log('— Two different cards stay separate —')
{
  // 72001 and 73009 are genuinely different cards (a replacement), not spelling
  // variants. Merging them would fabricate a card that never existed.
  const s = summarizeCardActivity(
    [
      row({ accountName: AMEX, amount: 500 }),
      row({ accountName: 'American Express ending 0-72001', amount: 900 }),
      row({ accountName: AMEX, amount: 100 }),
    ],
    { today: TODAY },
  )
  check('two accounts', s.accounts.length, 2)
  check('busiest first', s.accounts[0].accountName, AMEX)
  check('73009 total', s.accounts[0].totalCharges, 600)
  check('72001 total', s.accounts[1].totalCharges, 900)
}

// ---------------------------------------------------------------------------
console.log('— An unknown ledger type is surfaced, not silently dropped —')
{
  const s = summarizeCardActivity(
    [
      row({ transactionType: 'expense', amount: 100 }),
      row({ transactionType: 'chargeback', amount: 75 }),
    ],
    { today: TODAY },
  )
  check('unknown type named', s.unrecognizedTypes, ['chargeback'])
  // It must not quietly join either side of the money math...
  check('money totals exclude it', s.accounts[0].impliedNet, 100)
  // ...but the transaction count must stay truthful so the row is not invisible.
  check('txn count still counts it', s.accounts[0].txnCount, 2)
}

// ---------------------------------------------------------------------------
console.log('— Empty ledger reports no data rather than zeros —')
{
  const s = summarizeCardActivity([], { today: TODAY })
  ok('hasData false', !s.hasData)
  check('no accounts', s.accounts.length, 0)
  check('nothing behind', s.behindCount, 0)
}

// ---------------------------------------------------------------------------
console.log('— Reconciliation: no confirmed balance —')
{
  const s = summarizeCardActivity(
    [
      row({ transactionDate: '2026-01-06', amount: 5000 }),
      row({ transactionDate: '2026-07-03', transactionType: 'payment', amount: 1000 }),
    ],
    { today: TODAY },
  )
  const c = checkCardBalance(s.accounts[0], null, { balanceConfirmed: false })
  check('status', c.status, 'no_balance_entered')
  // The critical one: null, never 0. A $0 on this card reads as "paid off".
  check('entered stays null, never 0', c.enteredOwed, null)
  check('difference is null, not 0', c.difference, null)
  check('implied still reported', c.impliedNet, 4000)
  ok(
    'baseline assumption stated',
    c.notes.some((n) => n.includes('2026-01-06') && n.includes('not confirmed')),
    c.notes.join(' | '),
  )
  ok(
    'says it cannot be verified',
    c.notes.some((n) => n.includes('cannot be verified')),
  )
}

// ---------------------------------------------------------------------------
console.log('— Reconciliation: a zero balance the owner DID confirm —')
{
  // A confirmed $0 is real information and must be distinguishable from "not
  // recorded". This is the inverse of the trap above.
  const s = summarizeCardActivity([row({ amount: 0 })], { today: TODAY })
  const c = checkCardBalance(s.accounts[0], 0, { balanceConfirmed: true })
  check('confirmed zero is a number, not null', c.enteredOwed, 0)
  check('and it reconciles', c.status, 'matches')
}

// ---------------------------------------------------------------------------
console.log('— Reconciliation: a gap names BOTH possible causes —')
{
  const s = summarizeCardActivity(
    [row({ transactionDate: '2026-01-06', amount: 4000 })],
    { today: TODAY },
  )
  const c = checkCardBalance(s.accounts[0], 6500, { balanceConfirmed: true })
  check('status differs', c.status, 'differs')
  check('difference', c.difference, 2500)
  const joined = c.notes.join(' ')
  ok('names a pre-existing balance', joined.includes('carried a balance'))
  ok('names missing transactions', joined.includes('transactions are missing'))
  ok(
    'does not assert a single cause',
    !/\bmust be\b|\bthis means the card\b/i.test(joined),
    joined,
  )
}

// ---------------------------------------------------------------------------
console.log('— Reconciliation: entered LOWER than history explains —')
{
  const s = summarizeCardActivity(
    [row({ transactionDate: '2026-01-06', amount: 4000 })],
    { today: TODAY },
  )
  const c = checkCardBalance(s.accounts[0], 1000, { balanceConfirmed: true })
  check('negative difference', c.difference, -3000)
  ok(
    'explains the other direction',
    c.notes.some((n) => n.includes('payments are missing')),
  )
}

// ---------------------------------------------------------------------------
console.log('— Reconciliation warns that recent spend is excluded —')
{
  const s = summarizeCardActivity(
    [row({ transactionDate: '2026-07-03', amount: 4000 })],
    { today: TODAY },
  )
  const c = checkCardBalance(s.accounts[0], 4000, { balanceConfirmed: true })
  ok(
    'says history stops before today',
    c.notes.some((n) => n.includes('only recorded through 2026-07-03')),
    c.notes.join(' | '),
  )
}

// ---------------------------------------------------------------------------
console.log('— A confirmed balance with balanceConfirmed=false is not trusted —')
{
  // Guard against a caller passing a stale/never-confirmed row's balance through.
  const s = summarizeCardActivity([row({ amount: 100 })], { today: TODAY })
  const c = checkCardBalance(s.accounts[0], 9999, { balanceConfirmed: false })
  check('ignored', c.enteredOwed, null)
  check('status', c.status, 'no_balance_entered')
}

// ---------------------------------------------------------------------------
console.log('— typicalMonthlyCharges: median, not mean —')
{
  const months = [
    { monthKey: '2026-06', charges: 4000, payments: 0, refunds: 0, net: 4000, txnCount: 1 },
    { monthKey: '2026-05', charges: 5000, payments: 0, refunds: 0, net: 5000, txnCount: 1 },
    { monthKey: '2026-04', charges: 60000, payments: 0, refunds: 0, net: 60000, txnCount: 1 },
    { monthKey: '2026-03', charges: 4500, payments: 0, refunds: 0, net: 4500, txnCount: 1 },
  ]
  // Newest (06) dropped as partial -> [5000, 60000, 4500] -> median 5000.
  // The mean would be ~23,167: one big equipment month would nearly 5x the estimate
  // and turn an honest warning into an alarming one.
  check('median resists the outlier', typicalMonthlyCharges(months), 5000)
}

// ---------------------------------------------------------------------------
console.log('— typicalMonthlyCharges: the partial newest month is excluded —')
{
  // This is the real shape of the owner's data: the last month on file holds only
  // 2026-07-01..07-03 ($255) against a $3.3k-$11.2k norm. Including that 3-day month
  // would drag "typical" toward $255 and UNDERSTATE how much the stale feed is hiding,
  // which is the exact failure the staleness warning exists to prevent.
  const months = [
    { monthKey: '2026-07', charges: 255, payments: 0, refunds: 0, net: 255, txnCount: 2 },
    { monthKey: '2026-06', charges: 8000, payments: 0, refunds: 0, net: 8000, txnCount: 9 },
    { monthKey: '2026-05', charges: 6000, payments: 0, refunds: 0, net: 6000, txnCount: 9 },
  ]
  check('ignores the 3-day month', typicalMonthlyCharges(months), 7000)
  ok(
    'and is far above the partial month',
    (typicalMonthlyCharges(months) ?? 0) > 255 * 10,
  )
}

// ---------------------------------------------------------------------------
console.log('— typicalMonthlyCharges: honest with thin history —')
{
  // Under 3 months there is nothing to spare, so every month is used rather than
  // returning null and losing the only signal available.
  const two = [
    { monthKey: '2026-06', charges: 1000, payments: 0, refunds: 0, net: 1000, txnCount: 1 },
    { monthKey: '2026-05', charges: 3000, payments: 0, refunds: 0, net: 3000, txnCount: 1 },
  ]
  check('averages the two', typicalMonthlyCharges(two), 2000)
  check('no months -> null, never 0', typicalMonthlyCharges([]), null)
}

// ---------------------------------------------------------------------------
console.log('— typicalMonthlyCharges: order-independent —')
{
  // A caller passing oldest-first must not cause the WRONG month to be dropped.
  const newestFirst = [
    { monthKey: '2026-07', charges: 200, payments: 0, refunds: 0, net: 200, txnCount: 1 },
    { monthKey: '2026-06', charges: 9000, payments: 0, refunds: 0, net: 9000, txnCount: 1 },
    { monthKey: '2026-05', charges: 7000, payments: 0, refunds: 0, net: 7000, txnCount: 1 },
  ]
  const oldestFirst = [...newestFirst].reverse()
  check(
    'same answer either way',
    typicalMonthlyCharges(oldestFirst),
    typicalMonthlyCharges(newestFirst),
  )
}

// ---------------------------------------------------------------------------
console.log('— formatOwedAmount never renders unknown as $0 —')
{
  // On a card that runs thousands a month, "$0.00" reads as "paid off" and understates
  // real exposure to nothing. Unknown must say so in words.
  check('null', formatOwedAmount(null), 'Not recorded')
  check('undefined', formatOwedAmount(undefined), 'Not recorded')
  ok('a real zero still shows as money', formatOwedAmount(0).includes('0'))
  ok('and is not the words', formatOwedAmount(0) !== 'Not recorded')
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' -', f)
  process.exit(1)
}
