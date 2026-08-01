/**
 * Regression tests for two related fixes.
 *
 * 1. `payeeKeyOf` used to keep per-transaction reference codes, so every Square
 *    payroll run ("SQUARE INC PAYROLL T3HE2CY0135A7GJ") became its own group.
 *    54 payroll rows produced 54 groups of one, which silently defeated category
 *    learning: a category assigned 39 times could never reach a new payroll row.
 *    Reference codes are now stripped — but ONLY while an identifying token
 *    survives, otherwise "Square Inc SQ250505 <ref>" would collapse to "INC" and
 *    sweep sales deposits in with card fees.
 *
 * 2. `presentWindowStart` scopes data-quality warnings to last month onward.
 *    Measured over all history the warning was dominated by ~200 `CHECK ####`
 *    lines from 2025 that name no payee on the statement, so it always reported a
 *    six-figure problem that no review could clear.
 */

import { payeeKeyOf, isGenericDescription } from '../lib/transaction-groups'
import { presentWindowStart } from '../lib/cash-flow-service'
import { normalizeDescription } from '../lib/transactions'

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

function ok(name: string, cond: boolean) {
  check(name, cond, true)
}

const key = (desc: string) => payeeKeyOf(normalizeDescription(desc))

console.log('\npayeeKeyOf — reference codes must not fragment a payee')
{
  // The real descriptions, with their real Square reference codes.
  const payrollRuns = [
    'Square Inc PAYROLL T3HE2CY0135A7GJ',
    'Square Inc PAYROLL T5JK9DZ1247B8HL',
    'Square Inc PAYROLL T7MN4FX3358C9KP',
  ]
  const keys = new Set(payrollRuns.map(key))
  check('three payroll runs collapse to one group', keys.size, 1)
  // "SQUARE" is stripped as processor noise on purpose, so that `SQ *MERCHANT`
  // resolves to the real merchant rather than to Square. What must survive is the
  // part that says what this payment was.
  check('the group is labelled by what survives', [...keys][0], 'PAYROLL')

  // The bug, stated directly: distinct refs must not mean distinct payees.
  ok(
    'differing reference codes do not split the group',
    key(payrollRuns[0]) === key(payrollRuns[1]),
  )
}

console.log('\npayeeKeyOf — but must not over-merge unrelated activity')
{
  // These differ only in a code. Stripping it would leave "INC", which would put
  // sales deposits and card-processing fees in one bucket.
  const a = key('Square Inc SQ250505 A1B2C3D4E5')
  const b = key('Square Inc SQ250612 F6G7H8I9J0')
  ok('deposit lines keep their distinguishing code', a !== b)
  ok('key is never just a corporate suffix', a !== 'INC' && b !== 'INC')

  // Distinct real vendors must stay distinct.
  ok(
    'different vendors stay separate',
    key('SYSCO FOODS 12345') !== key('QUIRCH FOODS 88888'),
  )
}

console.log('\npayeeKeyOf — merchant names containing digits survive')
{
  // The reference-token rule requires >=6 chars, >=2 digits and a letter, so
  // ordinary names with digits must be untouched.
  ok('7 ELEVEN keeps its name', key('7 ELEVEN 4021').includes('ELEVEN'))
  ok('76 STATION keeps its name', key('76 STATION').includes('STATION'))
  ok(
    'same merchant, different store number groups together',
    key('WALMART STORE 4021') === key('WALMART STORE 5566'),
  )
}

console.log('\npayeeKeyOf — bank abbreviations of one concept fold together')
{
  // The statement writes the same Square payroll debit both ways, which split one
  // vendor into two rows of "Where the Money Went".
  ok(
    'PAYR and PAYROLL are one group',
    key('Square Inc PAYR DD T3NVKKVMZ2SQNCK') ===
      key('Square Inc PAYROLL T325C9J1FKMWNTD'),
  )
  check(
    'the group is labelled PAYROLL, not PAYR',
    key('Square Inc PAYR DD T3NVKKVMZ2SQNCK'),
    'PAYROLL',
  )
  ok(
    'unrelated vendors are not folded by the synonym rule',
    key('PAYPAL SOMEVENDOR 1234') !== key('Square Inc PAYROLL T325C9J1FKMWNTD'),
  )
}

console.log('\ngeneric statement lines still group as unidentified')
{
  ok('CHECK 1041 is generic', isGenericDescription(normalizeDescription('CHECK 1041')))
  check(
    'all CHECK lines share one group',
    new Set(['CHECK 1041', 'CHECK 1042', 'CHECK 9999'].map(key)).size,
    1,
  )
}

console.log('\npresentWindowStart — last complete month onward')
{
  check('Aug 1 2026 -> July 2026', presentWindowStart('2026-08-01'), '2026-07-01')
  check('mid-month is the same', presentWindowStart('2026-08-17'), '2026-07-01')
  check('January rolls back a year', presentWindowStart('2026-01-09'), '2025-12-01')
  check('March -> February', presentWindowStart('2026-03-31'), '2026-02-01')
  check('leap-ish boundary is fine', presentWindowStart('2024-03-01'), '2024-02-01')

  // The point of the change: 2025 CHECK backlog falls outside the window.
  const start = presentWindowStart('2026-08-01')
  ok('2025 history is excluded', '2025-06-14' < start)
  ok('July 2026 is included', '2026-07-15' >= start)
  ok('August 2026 is included', '2026-08-01' >= start)
}

console.log('')
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
