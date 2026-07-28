/**
 * Verification for lib/sales-source.ts — npx tsx scripts/verify-sales-source.ts
 *
 * The dangerous failures here are silent: a sync overwriting a manual
 * correction, an empty source blanking a real number, or a locked month
 * moving. Each of those has an explicit test.
 */

import {
  resolveMonthSales,
  resolveWinner,
  asSalesSource,
  explainResolution,
  SOURCE_RANK,
} from '../lib/sales-source'

let pass = 0
let fail = 0
const failures: string[] = []

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`)
  }
}

/* ---------------- rank ordering ---------------- */
// The whole design depends on this order; assert it rather than trusting it.
eq(SOURCE_RANK.manual > SOURCE_RANK.square_api, true, 'rank: manual beats API')
eq(SOURCE_RANK.square_api > SOURCE_RANK.square_csv, true, 'rank: API beats CSV')
eq(SOURCE_RANK.square_csv > SOURCE_RANK.calculated, true, 'rank: CSV beats bank estimate')

/* ---------------- asSalesSource ---------------- */
eq(asSalesSource('manual'), 'manual', 'narrow: valid')
eq(asSalesSource('nonsense'), null, 'narrow: invalid is null')
eq(asSalesSource(null), null, 'narrow: null')

/* ---------------- resolveWinner ---------------- */
eq(
  resolveWinner([
    { source: 'calculated', value: 100 },
    { source: 'square_api', value: 200 },
  ]),
  { source: 'square_api', value: 200 },
  'winner: higher rank wins',
)
// An absent higher-ranked source must not win.
eq(
  resolveWinner([
    { source: 'manual', value: null },
    { source: 'calculated', value: 100 },
  ]),
  { source: 'calculated', value: 100 },
  'winner: null-valued source does not win',
)
eq(resolveWinner([{ source: 'manual', value: null }]), null, 'winner: all null')
eq(resolveWinner([]), null, 'winner: empty')

/* ---------------- resolveMonthSales ---------------- */
// Square API beats the bank estimate.
let r = resolveMonthSales({ squareApi: 5000, calculated: 4200 })
eq(r.value, 5000, 'resolve: API wins over calculated')
eq(r.source, 'square_api', 'resolve: source is API')
eq(r.conflict, true, 'resolve: disagreement flagged')

// THE critical case: a manual correction must survive a Square sync.
r = resolveMonthSales({ manual: 5100, squareApi: 5000, calculated: 4200 })
eq(r.value, 5100, 'resolve: manual correction is not overwritten by sync')
eq(r.source, 'manual', 'resolve: manual is the source')

// CSV beats bank estimate but loses to the live API.
r = resolveMonthSales({ squareCsv: 4900, calculated: 4200 })
eq(r.value, 4900, 'resolve: CSV beats calculated')
r = resolveMonthSales({ squareApi: 5000, squareCsv: 4900 })
eq(r.value, 5000, 'resolve: API beats CSV')

// An empty Square connection must not blank out a real bank figure.
r = resolveMonthSales({ squareApi: null, squareCsv: null, calculated: 4200 })
eq(r.value, 4200, 'resolve: empty Square does not blank the estimate')
eq(r.source, 'calculated', 'resolve: falls back to calculated')

// No data anywhere reports null, not zero. Zero would read as "no sales".
r = resolveMonthSales({})
eq(r.value, null, 'resolve: no data is null, never 0')
eq(r.source, null, 'resolve: no source')
eq(r.conflict, false, 'resolve: no conflict when no data')

// A genuine zero is preserved and outranks nothing else.
r = resolveMonthSales({ squareApi: 0 })
eq(r.value, 0, 'resolve: real zero preserved')
eq(r.source, 'square_api', 'resolve: zero still has a source')

// Agreement within a cent is not a conflict (float noise).
r = resolveMonthSales({ squareApi: 5000, calculated: 5000.004 })
eq(r.conflict, false, 'resolve: sub-cent difference is not a conflict')
r = resolveMonthSales({ squareApi: 5000, calculated: 5000.5 })
eq(r.conflict, true, 'resolve: half-dollar difference is a conflict')

/* ---------------- locking ---------------- */
// A locked month must not move, even when the API has a different number.
r = resolveMonthSales({ locked: true, manual: 5100, squareApi: 9999 })
eq(r.value, 5100, 'lock: locked month ignores API')
eq(r.locked, true, 'lock: reports locked')
eq(r.source, 'manual', 'lock: source stays manual')
eq(r.conflict, true, 'lock: still surfaces the disagreement')

// Locked with no manual figure can't freeze anything, so normal rules apply.
r = resolveMonthSales({ locked: true, manual: null, squareApi: 5000 })
eq(r.value, 5000, 'lock: locked without manual falls through to API')

/* ---------------- explanations ---------------- */
const noData = explainResolution(resolveMonthSales({}))
eq(noData.includes('No sales figure'), true, 'explain: no data message')
const lockedMsg = explainResolution(
  resolveMonthSales({ locked: true, manual: 100, squareApi: 200 }),
)
eq(lockedMsg.toLowerCase().includes('locked'), true, 'explain: mentions locked')
const conflictMsg = explainResolution(resolveMonthSales({ squareApi: 5000, calculated: 4200 }))
eq(conflictMsg.includes('4,200'), true, 'explain: shows the competing figure')
const cleanMsg = explainResolution(resolveMonthSales({ squareApi: 5000 }))
eq(cleanMsg, 'From Square (live sync).', 'explain: single source is terse')

console.log(`\n${pass} passed, ${fail} failed\n`)
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
