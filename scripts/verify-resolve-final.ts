/**
 * Tests for `resolveFinal` — which figure the business actually reports.
 *
 * This function is why nine months of retail revenue were understated. It knew
 * only about manual and calculated figures, so a month with real Square data
 * still reported the bank-deposit estimate. Nothing errored; the wrong number
 * just looked authoritative.
 *
 * Run: npx tsx scripts/verify-resolve-final.ts
 */
import { resolveFinal } from '../lib/sales-calculator'

let pass = 0
let fail = 0

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`)
  }
}

const NONE = {
  calculatedWholesale: null,
  calculatedRetail: null,
  manualWholesale: null,
  manualRetail: null,
}

console.log('\nresolveFinal\n')

/* ---------------- the regression ---------------- */
// 2026-06 exactly as it stands in the database: Square recorded $70,521.14 of
// retail but the reported figure was the $47,263.17 bank estimate. Before the
// fix this returned the calculated figure, understating the month by $23,257.97.
const june2026 = resolveFinal({
  ...NONE,
  calculatedWholesale: 0,
  calculatedRetail: 47263.17,
  squareWholesale: 0,
  squareRetail: 70521.14,
})
eq(june2026.retail, 70521.14, 'Square retail beats the bank-deposit estimate')
eq(june2026.source, 'square', 'and the month is labelled as Square-sourced')

// The owner's own entry still wins. Square cannot know a deposit was really two
// invoices, so an explicit manual figure must not be overridden.
eq(
  resolveFinal({
    ...NONE,
    calculatedRetail: 100,
    squareRetail: 200,
    manualRetail: 300,
    manualWholesale: 10,
    squareWholesale: 20,
    calculatedWholesale: 30,
  }),
  { wholesale: 10, retail: 300, source: 'manual' },
  'a manual figure outranks both Square and calculated',
)

/* ---------------- backwards compatibility ---------------- */
// Callers that pass no Square figures must behave exactly as before, otherwise
// this fix would quietly change months that were already correct.
eq(
  resolveFinal({
    ...NONE,
    calculatedWholesale: 500,
    calculatedRetail: 1500,
  }),
  { wholesale: 500, retail: 1500, source: 'calculated' },
  'calculated-only months are unchanged',
)
eq(
  resolveFinal({
    ...NONE,
    manualWholesale: 500,
    manualRetail: 1500,
  }),
  { wholesale: 500, retail: 1500, source: 'manual' },
  'manual-only months are unchanged',
)
eq(resolveFinal(NONE), { wholesale: 0, retail: 0, source: 'empty' }, 'no data reads as empty')

// A month where only one channel is known stays "mixed": calling it "manual"
// would imply the missing channel had been reviewed when it has not.
eq(
  resolveFinal({ ...NONE, manualRetail: 1500 }).source,
  'mixed',
  'one channel known is mixed, not manual',
)
eq(
  resolveFinal({ ...NONE, calculatedRetail: 1500 }).source,
  'mixed',
  'one calculated channel is mixed too',
)

/* ---------------- mixed tiers ---------------- */
// Retail from Square, wholesale entered by hand: neither label alone is true.
eq(
  resolveFinal({ ...NONE, manualWholesale: 400, squareRetail: 900 }),
  { wholesale: 400, retail: 900, source: 'mixed' },
  'different tiers per channel reads as mixed',
)
eq(
  resolveFinal({ ...NONE, squareWholesale: 10, squareRetail: 20 }).source,
  'square',
  'both channels from Square reads as square',
)

/* ---------------- zero and absent are different ---------------- */
// A real zero is a fact ("we sold nothing"); null is an absence. Treating zero
// as missing would silently fall through to a lesser source.
eq(
  resolveFinal({ ...NONE, calculatedRetail: 5000, squareRetail: 0 }),
  { wholesale: 0, retail: 0, source: 'mixed' },
  'a Square zero is respected, not treated as missing',
)
eq(
  resolveFinal({ ...NONE, calculatedRetail: 5000, squareRetail: null }).retail,
  5000,
  'a null Square figure falls through to calculated',
)
// Non-finite junk must not poison a figure.
eq(
  resolveFinal({ ...NONE, calculatedRetail: 5000, squareRetail: Number.NaN }).retail,
  5000,
  'NaN is ignored and the next source is used',
)

/* ---------------- rounding ---------------- */
eq(
  resolveFinal({ ...NONE, squareWholesale: 0.005, squareRetail: 10.994 }),
  { wholesale: 0.01, retail: 10.99, source: 'square' },
  'figures are rounded to cents',
)

console.log(`\nresolveFinal: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
