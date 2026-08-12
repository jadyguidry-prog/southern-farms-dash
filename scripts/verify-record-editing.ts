/**
 * Guards the two editing paths added so records can be corrected after submission.
 *
 * The danger in editing is not the edit itself, it is the SILENT part:
 *
 *  1. `updateRecord` writes EVERY field in a table def on every save. Any field the edit
 *     form fails to prefill submits blank and NULLs a column the owner never touched.
 *     A date is the worst case because <input type="date"> renders an unparsed value as
 *     empty, so the field looks legitimately blank right before it erases itself.
 *  2. Editing a payment amount changes whether its bill is covered. Leaving the bill's
 *     status alone desyncs them — a $5,000 check corrected to $500 would leave the bill
 *     marked Paid with $4,500 genuinely still owed. Money owed and invisible is the
 *     expensive direction to be wrong in.
 *  3. A cleared payment is an assertion that this record equals a specific bank
 *     transaction. Editing amount or date breaks that, and must warn.
 *
 * Run: npx tsx scripts/verify-record-editing.ts
 */

import {
  coerceFieldValue,
  toInputValue,
  selectOptionsFor,
  getTableDef,
  ADMIN_TABLES,
} from '../lib/admin-config'
import {
  validatePaymentEdit,
  editBreaksReconciliation,
  resolveOneTimeBillStatus,
} from '../lib/bill-pay-shared'

let pass = 0
let fail = 0

function check(label: string, actual: unknown, expected: unknown) {
  if (Object.is(actual, expected)) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function ok(label: string, condition: boolean, detail = '') {
  if (condition) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('— Dates survive the round trip (the silent-wipe case) —')
{
  // A plain Postgres `date`.
  check('date column prefills', toInputValue('2026-08-26', 'date'), '2026-08-26')
  // A timestamptz. <input type="date"> cannot parse this and renders BLANK, so without
  // truncation the field looks empty and saving clears a real due date.
  check(
    'timestamp prefills as a date input can read',
    toInputValue('2026-08-26T00:00:00+00:00', 'date'),
    '2026-08-26',
  )
  check('Date object prefills', toInputValue(new Date('2026-08-26T00:00:00Z'), 'date'), '2026-08-26')
  // And the round trip must be lossless: prefill → submit → coerce returns the original.
  const original = '2026-08-26'
  check(
    'date round-trips unchanged',
    coerceFieldValue(toInputValue('2026-08-26T00:00:00+00:00', 'date'), 'date'),
    original,
  )
}

console.log('')
console.log('— A genuinely empty field stays empty, and a real zero stays zero —')
{
  check('null prefills blank', toInputValue(null, 'number'), '')
  check('undefined prefills blank', toInputValue(undefined, 'date'), '')
  // The distinction the whole read path depends on: 0 is a recorded figure, not a blank.
  check('zero prefills as "0", not blank', toInputValue(0, 'number'), '0')
  ok(
    'a prefilled zero coerces back to 0 rather than null',
    coerceFieldValue(toInputValue(0, 'number'), 'number', true) === 0,
    'a real zero must not become "not recorded" just by opening the edit form',
  )
  // And the inverse: a NULL must not come back as 0 on a blankIsNull field, which would
  // assert "nothing due" on a card that has simply never been entered.
  check(
    'a prefilled null stays null on a blankIsNull field',
    coerceFieldValue(toInputValue(null, 'number'), 'number', true),
    null,
  )
}

console.log('')
console.log('— Booleans round-trip through the select options —')
{
  check('true prefills as "true"', toInputValue(true, 'select'), 'true')
  check('false prefills as "false"', toInputValue(false, 'select'), 'false')
  check('"false" coerces back to false', coerceFieldValue('false', 'select'), false)
  // self_scheduled=false is meaningful (it means "the vendor set this date"), so it must
  // not be lost by an edit that never touched the field.
  check(
    'false survives prefill → save',
    coerceFieldValue(toInputValue(false, 'select'), 'select'),
    false,
  )
}

console.log('')
console.log('— A stored value outside the option list is not silently dropped —')
{
  const def = getTableDef('cash_obligations')!
  const category = def.fields.find((f) => f.name === 'category')!
  // Legacy rows and hand-run SQL both produce values that predate the current options.
  // A Radix Select renders an unlisted value as its PLACEHOLDER, so it looks like
  // nothing was chosen and saving writes NULL over something perfectly valid.
  const withLegacy = selectOptionsFor(category, 'Freight')
  ok('an unlisted stored value is offered', withLegacy.includes('Freight'))
  ok('the configured options are still offered', withLegacy.includes('Vendor'))
  ok('the stored value leads so it renders as selected', withLegacy[0] === 'Freight')

  const normal = selectOptionsFor(category, 'Vendor')
  check('a listed value does not duplicate', normal.filter((o) => o === 'Vendor').length, 1)

  const blank = selectOptionsFor(category, null)
  check('a blank value adds nothing', blank.length, category.options!.length)
}

console.log('')
console.log('— Every editable field can prefill every column it writes —')
{
  // The structural guarantee behind hazard 1. updateRecord writes the full field set, so
  // a field type that cannot prefill would blank its column on save.
  for (const def of ADMIN_TABLES) {
    if (def.managedElsewhere) continue
    for (const f of def.fields) {
      const sample = f.type === 'number' ? 123.45 : f.type === 'date' ? '2026-08-26' : 'x'
      const prefilled = toInputValue(sample, f.type)
      ok(
        `${def.key}.${f.name} prefills non-blank`,
        prefilled !== '',
        'a blank prefill would NULL this column on save',
      )
    }
  }
}

console.log('')
console.log('— Derived tables stay read-only —')
{
  // Editing a calculated row looks like it works and is erased on the next
  // recalculation, which is worse than not offering it.
  const derived = ADMIN_TABLES.filter((t) => t.managedElsewhere)
  ok('at least one derived table exists to protect', derived.length > 0)
  for (const d of derived) {
    ok(`${d.key} points at its real controls`, Boolean(d.managedElsewhere?.href))
  }
}

console.log('')
console.log('— A payment edit must still be a payment —')
{
  check('a valid edit passes', validatePaymentEdit({ amount: 500, paymentDate: '2026-08-05' }), null)
  ok(
    'zero is refused',
    validatePaymentEdit({ amount: 0, paymentDate: '2026-08-05' }) !== null,
    'a $0 payment closes a bill nobody paid',
  )
  ok('negative is refused', validatePaymentEdit({ amount: -5, paymentDate: '2026-08-05' }) !== null)
  ok('NaN is refused', validatePaymentEdit({ amount: Number.NaN, paymentDate: '2026-08-05' }) !== null)
  ok('a malformed date is refused', validatePaymentEdit({ amount: 500, paymentDate: '8/5/2026' }) !== null)
  ok('a blank date is refused', validatePaymentEdit({ amount: 500, paymentDate: '' }) !== null)
}

console.log('')
console.log('— Cleared payments warn only when the bank match actually breaks —')
{
  const cleared = { amount: 5025.7, paymentDate: '2026-08-05', status: 'cleared' }

  ok(
    'changing the amount warns',
    editBreaksReconciliation(cleared, { amount: 500, paymentDate: '2026-08-05' }),
  )
  ok(
    'changing the date warns',
    editBreaksReconciliation(cleared, { amount: 5025.7, paymentDate: '2026-08-06' }),
  )
  // The point of the warning is that it means something. If it fired on a memo fix the
  // owner would learn to click through it, and it would stop protecting the real case.
  ok(
    'an unchanged amount and date does NOT warn',
    !editBreaksReconciliation(cleared, { amount: 5025.7, paymentDate: '2026-08-05' }),
    'warning on a descriptive-only edit trains the owner to dismiss it',
  )
  // A numeric column round-tripping through a float can differ in the last bit.
  ok(
    'float noise does not warn',
    !editBreaksReconciliation(
      { amount: 5025.7, paymentDate: '2026-08-05', status: 'cleared' },
      { amount: 5025.700000000001, paymentDate: '2026-08-05' },
    ),
  )
  // A timestamp vs a date string is the same day, not a change.
  ok(
    'a timestamp form of the same date does not warn',
    !editBreaksReconciliation(
      { amount: 5025.7, paymentDate: '2026-08-05T00:00:00+00:00', status: 'cleared' },
      { amount: 5025.7, paymentDate: '2026-08-05' },
    ),
  )
  // An OUTSTANDING payment has no bank match to break, so it must edit freely.
  ok(
    'an outstanding payment never warns',
    !editBreaksReconciliation(
      { amount: 5025.7, paymentDate: '2026-08-05', status: 'outstanding' },
      { amount: 1, paymentDate: '2020-01-01' },
    ),
    'warning here would make ordinary corrections feel dangerous',
  )
  // Rounding to cents must not miss a real sub-dollar correction.
  ok(
    'a one-cent correction still warns',
    editBreaksReconciliation(cleared, { amount: 5025.71, paymentDate: '2026-08-05' }),
  )
}

console.log('')
console.log('— Editing an amount re-derives the bill status —')
{
  // This is hazard 2, expressed against the same helper the action calls. The action
  // re-runs resolveOneTimeBillStatus after every edit for exactly this reason.
  const billAmount = 5025.7

  check('a full payment closes the bill', resolveOneTimeBillStatus(billAmount, 5025.7), 'Paid')
  // The regression that matters: correcting the check DOWN must reopen the bill.
  check(
    'correcting the payment down reopens the bill',
    resolveOneTimeBillStatus(billAmount, 500),
    'Pending',
  )
  // And correcting UP must close it, so the reverse fix is equally live.
  check(
    'correcting the payment up closes the bill',
    resolveOneTimeBillStatus(billAmount, 6000),
    'Paid',
  )
  // A cent short must not leave a bill permanently open on float noise.
  check(
    'a rounding-level shortfall still counts as covered',
    resolveOneTimeBillStatus(billAmount, 5025.695),
    'Paid',
  )
}

console.log('')
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
