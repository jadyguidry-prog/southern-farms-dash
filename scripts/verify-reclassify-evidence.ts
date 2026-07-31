/**
 * Verifies the evidence test that guards reclassification.
 *
 * The real-world case this exists for: 47 rows labelled `Sales Deposit` that are
 * actually monthly Square fees. The old label-only rule would have flipped them
 * to income. Every assertion below is derived from the owner's real data shape.
 */
import { assessReclassification, type EvidenceRow } from '../lib/reclassify-evidence'

let pass = 0
let fail = 0

function eq(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass += 1
  else {
    fail += 1
    console.log(`  FAIL ${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`)
  }
}

function ok(cond: boolean, label: string) {
  eq(Boolean(cond), true, label)
}

/* ---------------- the real Square fee shape ---------------- */
// Fixed amounts, outflow, early in the month, across 9 months.
// Amounts are POSITIVE magnitudes, exactly as this database stores them, with
// direction carried separately. An earlier version inferred direction from the
// sign and consequently told the owner these rows were "money arriving".
const fees: EvidenceRow[] = []
for (const mo of ['01', '02', '03', '04', '05', '06', '07', '08', '09']) {
  fees.push({ amount: 98.26, direction: 'out', date: `2025-${mo}-03` })
  fees.push({ amount: 33.12, direction: 'out', date: `2025-${mo}-02` })
}
const feeReport = assessReclassification(fees)
eq(feeReport.verdict, 'likely_recurring_fee', 'square fees: verdict is recurring fee')
ok(feeReport.blocksReclassification, 'square fees: reclassification is blocked')
eq(feeReport.monthCount, 9, 'square fees: 9 months')
eq(feeReport.outflowShare, 1, 'square fees: all outflow')
ok(
  feeReport.recurringAmounts.some((r) => r.amount === 98.26 && r.monthCount === 9),
  'square fees: $98.26 detected in 9 months',
)
ok(
  feeReport.reasons.some((r) => r.includes('never arrived')),
  'square fees: explains the double harm',
)

/* ---------------- real inbound payouts ---------------- */
// Varying amounts, inbound, spread through the month.
const payouts: EvidenceRow[] = [
  { amount: 1904.11, direction: 'in', date: '2025-05-04' },
  { amount: 2210.87, direction: 'in', date: '2025-05-12' },
  { amount: 1533.42, direction: 'in', date: '2025-05-19' },
  { amount: 2984.65, direction: 'in', date: '2025-06-08' },
  { amount: 1122.9, direction: 'in', date: '2025-06-22' },
  { amount: 3410.55, direction: 'in', date: '2025-07-15' },
]
const payoutReport = assessReclassification(payouts)
eq(payoutReport.verdict, 'likely_income', 'payouts: verdict is income')
ok(!payoutReport.blocksReclassification, 'payouts: reclassification allowed')

/* ---------------- guard: fixed inbound retainer is NOT a fee ---------------- */
// Repeats monthly but arrives — must not be called a fee.
const retainer: EvidenceRow[] = ['01', '02', '03', '04'].map((mo) => ({
  amount: 500,
  direction: 'in' as const,
  date: `2025-${mo}-03`,
}))
const retainerReport = assessReclassification(retainer)
ok(
  retainerReport.verdict !== 'likely_recurring_fee',
  'inbound retainer: not misread as an outgoing fee',
)

/* ---------------- guard: single outflow is not enough ---------------- */
const oneOff: EvidenceRow[] = [{ amount: 250, direction: 'out', date: '2025-04-17' }]
eq(assessReclassification(oneOff).verdict, 'unclear', 'single outflow: unclear, not a fee')
ok(
  assessReclassification(oneOff).blocksReclassification,
  'single outflow: still blocked from reclassification',
)

/* ---------------- guard: mixed directions must not auto-resolve ---------------- */
const mixed: EvidenceRow[] = [
  { amount: 98.26, direction: 'out', date: '2025-01-03' },
  { amount: 1904.11, direction: 'in', date: '2025-01-14' },
  { amount: 98.26, direction: 'out', date: '2025-02-03' },
  { amount: 2210.87, direction: 'in', date: '2025-02-16' },
]
const mixedReport = assessReclassification(mixed)
eq(mixedReport.verdict, 'unclear', 'mixed: verdict is unclear')
ok(mixedReport.blocksReclassification, 'mixed: blocked')
ok(
  mixedReport.reasons.some((r) => r.includes('Mixed directions')),
  'mixed: says the rows are not all the same kind',
)

/* ---------------- guard: 2 months is not "recurring" ---------------- */
const twoMonths: EvidenceRow[] = [
  { amount: 75, direction: 'out', date: '2025-01-03' },
  { amount: 75, direction: 'out', date: '2025-02-03' },
]
eq(
  assessReclassification(twoMonths).recurringAmounts.length,
  0,
  'two months: not yet a recurring signature',
)

/* ---------------- guard: empty input never green-lights a change ---------------- */
const empty = assessReclassification([])
eq(empty.verdict, 'unclear', 'empty: unclear')
ok(empty.blocksReclassification, 'empty: blocked')

/* ---------------- regression: positive magnitudes must not read as inbound ----
 * This database stores every amount as a positive number and carries direction
 * in `transaction_type`. Inferring direction from the sign made the report claim
 * outgoing fees were "money arriving in the account" — a false statement shown
 * to the owner. Direction must come only from `direction`.
 */
const positiveButOutgoing: EvidenceRow[] = ['01', '02', '03', '04', '05'].map((mo) => ({
  amount: 98.26,
  direction: 'out' as const,
  date: `2025-${mo}-03`,
}))
const posReport = assessReclassification(positiveButOutgoing)
eq(posReport.outflowShare, 1, 'positive amounts marked out are 100% outflow')
eq(posReport.verdict, 'likely_recurring_fee', 'positive-magnitude fees still detected as fees')
ok(
  posReport.reasons.some((r) => r.includes('imported as spending')),
  'positive-magnitude fees are described as spending, not as arriving',
)
ok(
  !posReport.reasons.some((r) => r.includes('coming in')),
  'never claims outgoing rows came in',
)

/* ---------------- no-invention guard ---------------- */
// The report must never state a month count higher than the data supports.
ok(feeReport.monthCount <= new Set(fees.map((f) => f.date.slice(0, 7))).size, 'no invented months')
eq(feeReport.rowCount, fees.length, 'row count matches input exactly')

console.log(`\nreclassify evidence: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
