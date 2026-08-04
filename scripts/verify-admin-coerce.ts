/**
 * Guards the admin write path against turning "not recorded" into a confident zero.
 *
 * The read path (lib/queries.ts, lib/card-safety.ts) is careful to keep NULL distinct
 * from 0 so an unentered statement balance cannot be mistaken for a paid-off card. The
 * write path quietly defeated that: every blank numeric field was saved as 0.
 *
 * On a card that runs five figures a month, "0 due" is not a harmless default — it is a
 * false statement about the business.
 *
 * Run: npx tsx scripts/verify-admin-coerce.ts
 */

import { coerceFieldValue, getTableDef } from '../lib/admin-config'

let pass = 0
let fail = 0

function check(label: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected)
  if (ok) {
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

console.log('— A blank flagged field stays NULL —')
{
  // The exact bug. Left blank, this used to save 0, which the card panel reads as a
  // confirmed "nothing due" and reports as a paid-off card.
  check('blank string → null', coerceFieldValue('', 'number', true), null)
  check('missing value → null', coerceFieldValue(null, 'number', true), null)
}

console.log('')
console.log('— Blank stays 0 where the column is NOT NULL —')
{
  // credit_limit and available_credit are NOT NULL DEFAULT 0 in Postgres. Forcing NULL
  // there would fail the write instead of recording the blank, so the old behaviour is
  // still correct for them and must be preserved.
  check('unflagged blank → 0', coerceFieldValue('', 'number'), 0)
  check('unflagged missing → 0', coerceFieldValue(null, 'number'), 0)
}

console.log('')
console.log('— A real zero is still a real zero —')
{
  // The inverse guard. A card genuinely paid to zero must record 0, not null: hedging a
  // known balance into "not recorded" is the same failure pointed the other way.
  check('explicit "0" → 0', coerceFieldValue('0', 'number', true), 0)
  check('explicit "0.00" → 0', coerceFieldValue('0.00', 'number', true), 0)
  check('explicit "$0" → 0', coerceFieldValue('$0', 'number', true), 0)
}

console.log('')
console.log('— Formatting from a pasted statement still parses —')
{
  check('currency and commas', coerceFieldValue('$6,072.14', 'number', true), 6072.14)
  check('percent sign', coerceFieldValue('18.5%', 'number'), 18.5)
  check('negative', coerceFieldValue('-1946.00', 'number', true), -1946)
}

console.log('')
console.log('— Non-numeric types are unaffected —')
{
  check('blank date → null', coerceFieldValue('', 'date', true), null)
  check('blank text → null', coerceFieldValue('', 'text'), null)
  check('text passes through', coerceFieldValue('Amex', 'text'), 'Amex')
  check('boolean-like true', coerceFieldValue('true', 'text'), true)
}

console.log('')
console.log('— The card fields are wired to the right rule —')
{
  // Asserting the CONFIG, not just the function: the fix only works if the flag is
  // actually set on the field the owner leaves blank.
  const def = getTableDef('bank_accounts')
  ok('bank_accounts is editable in admin', def != null)

  const byName = new Map((def?.fields ?? []).map((f) => [f.name, f]))

  const statement = byName.get('statement_balance')
  ok('statement_balance exists', statement != null)
  ok(
    'statement_balance keeps blanks as null',
    statement?.blankIsNull === true,
    'a blank would save as $0 and read as "paid off"',
  )

  // These are NOT NULL in the database, so they must NOT carry the flag.
  for (const name of ['credit_limit', 'available_credit', 'current_balance']) {
    const f = byName.get(name)
    ok(`${name} exists`, f != null)
    ok(
      `${name} is not flagged (NOT NULL column)`,
      f?.blankIsNull !== true,
      'flagging it would fail the write instead of recording a blank',
    )
  }

  // A blank limit lands as 0, and card-safety.ts treats `creditLimit > 0` as "known",
  // so 0 already means "unknown limit" downstream rather than a real zero limit.
  check('blank credit limit → 0', coerceFieldValue('', 'number', byName.get('credit_limit')?.blankIsNull), 0)

  // And the field the owner is about to fill in must round-trip a real figure.
  check(
    'a real balance saves as entered',
    coerceFieldValue('6072.14', 'number', byName.get('current_balance')?.blankIsNull),
    6072.14,
  )
}

console.log('')
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
