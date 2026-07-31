/**
 * Verifies the evidence test that guards reclassification.
 *
 * The real-world case this exists for: 47 rows labelled `Sales Deposit` that are
 * actually monthly Square fees. The old label-only rule would have flipped them
 * to income. Every assertion below is derived from the owner's real data shape.
 */
import {
  assessReclassification,
  deriveMerchantName,
  type EvidenceRow,
} from '../lib/reclassify-evidence'

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

/* ---------------- merchant name derivation ---------------- */
// Real descriptions from the owner's data: a shared merchant followed by a
// per-row reference id, which is why all 47 descriptions are unique.
const squareDescriptions = [
  'Square Inc SQ250501 T3YF62329G8PNS9',
  'Square Inc SQ250502 T3A02382FB6MRZP',
  'Square Inc SQ250505 T33ZFA5DQC40X6T',
  'Square Inc SQ250512 T3P9MTPCZTB1J4F',
]
eq(deriveMerchantName(squareDescriptions), 'Square', 'derives merchant, drops ids and "Inc"')

// A mixed group has no single merchant. Naming one would file unrelated
// spending under a confident-looking label, so it must refuse.
eq(
  deriveMerchantName([
    'Square Inc SQ250501 T3YF6',
    'Sysco Foods 88213',
    'City Water Dept 4402',
  ]),
  null,
  'refuses to name a merchant for a mixed group',
)

eq(
  deriveMerchantName(['Gulf Coast Supply 1201', 'Gulf Coast Supply 1202']),
  'Gulf Coast Supply',
  'keeps multi-word merchant names',
)

// Degenerate input must not throw or invent a name.
eq(deriveMerchantName([]), null, 'no merchant from no rows')
eq(deriveMerchantName(['SQ250501 T3YF62329G8PNS9']), null, 'no merchant from ids alone')
eq(deriveMerchantName(['', '']), null, 'no merchant from blank descriptions')
// A single stray row must not override an otherwise unanimous group.
eq(
  deriveMerchantName([...squareDescriptions, 'Sysco Foods 88213']),
  null,
  'one mismatched row blocks naming',
)

console.log(`\nreclassify evidence: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
