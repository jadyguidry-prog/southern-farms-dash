/**
 * Regression tests for reading a statement's direction column.
 *
 * The importer used to trust any type-column value that happened to match one of
 * our own type names. Two vocabularies collide on one word: a bank writes
 * "Credit" to mean money ARRIVED, while this app's `credit` type is a SPEND
 * OFFSET that REDUCES spending (see `SPEND_OFFSET_TYPES`).
 *
 * A checking export therefore landed with all 51 deposits stored as `credit` and
 * every payment inferred as `income` — the exact inverse. Those "credits" were
 * subtracted from $1,527 of real costs and the Cash Flow chart reported cash out
 * of -$96,116.47 for the month.
 *
 * The fix: direction words set the SIGN, never the type, and the semantic type is
 * then inferred from description + sign. These tests pin both that a bank's
 * "Credit"/"Debit" can no longer be taken at face value, and that genuine type
 * columns are still honoured.
 */

import {
  inferTransactionType,
  normalizeDescription,
  parseStatementDirection,
  trustedStatementType,
  canonicalizeSign,
  summarizeImportDirection,
  SPEND_TYPES,
  SPEND_OFFSET_TYPES,
  type TransactionType,
} from '../lib/transactions'

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

function ok(name: string, cond: boolean, detail = '') {
  check(name + (cond || !detail ? '' : ` (${detail})`), cond, true)
}

/**
 * Reproduce exactly what the importer now does for one CSV row: trust the type
 * column only when it is not a direction word, otherwise let the direction sign
 * the amount and infer the type.
 */
function importRow(rawType: string, description: string, magnitude: number): TransactionType {
  const known = trustedStatementType(rawType)
  if (known) return known
  const direction = parseStatementDirection(rawType)
  const signed = direction === null ? magnitude : direction * Math.abs(magnitude)
  return inferTransactionType(normalizeDescription(description), signed, description)
}

console.log('direction words are recognised, in both directions')
{
  check('Credit means money in', parseStatementDirection('Credit'), 1)
  check('DEBIT means money out', parseStatementDirection('DEBIT'), -1)
  check('cr/dr abbreviations', [parseStatementDirection('CR'), parseStatementDirection('dr')], [1, -1])
  check('deposit / withdrawal wording', [parseStatementDirection('Deposit'), parseStatementDirection('Withdrawal')], [1, -1])
  check('a real type is not a direction', parseStatementDirection('expense'), null)
  check('noise is not a direction', parseStatementDirection('misc'), null)
}

console.log("a bank's direction word is never used as a transaction type")
{
  // The whole bug in one assertion.
  check('"credit" is refused as a type', trustedStatementType('credit'), null)
  check('"debit" is refused as a type', trustedStatementType('debit'), null)
  check('genuine types are still honoured', trustedStatementType('refund'), 'refund')
  check('type matching is case-insensitive', trustedStatementType('Transfer'), 'transfer')
  check('unknown labels fall through to inference', trustedStatementType('ACH'), null)
}

console.log('an unsigned export with a Credit/Debit column classifies correctly')
{
  // These are the real July 2026 lines that were inverted.
  check(
    'Square payout on a Credit row is income',
    importRow('Credit', 'Square Inc SQ260701 T3NX9297RYCZXP3', 54_737),
    'income',
  )
  check('a DEPOSIT credit row is income', importRow('Credit', 'DEPOSIT', 36_414), 'income')
  check(
    'supplier purchase on a Debit row is an expense',
    importRow('Debit', 'Sysco Corporatio PURCHASE USBLXXXXX5794S', 23_790),
    'expense',
  )
  check(
    'payroll on a Debit row is an expense',
    importRow('Debit', 'Square Inc PAYROLL T3NJ89WAA0S6DJ0', 12_720),
    'expense',
  )
  check(
    'sales tax on a Debit row is an expense',
    importRow('Debit', 'SALESTAXACCOUNT SALES TAX 000000102668', 10_371),
    'expense',
  )
  // Description-based rules must still win over the direction fallback.
  check(
    'an inbound account transfer stays a transfer, not revenue',
    importRow('Credit', 'Internet Transfer From Acct 2008275 Confirm 1234', 3_600),
    'transfer',
  )
  check(
    'a loan refund stays a refund',
    importRow('Credit', 'Refund Loan #85419315 auto pay', 500),
    'refund',
  )
  check(
    'a card payoff stays a payment, not vendor spend',
    importRow('Debit', 'AMEX EPAYMENT ACH PMT A0020', 9_428),
    'payment',
  )
  check('an NSF charge is a fee', importRow('Debit', 'PAID NSF CHARGE', 35), 'fee')
}

console.log('the cash-flow effect of the bug is gone')
{
  // Model the month: deposits vs costs, as the chart aggregates them.
  const rows: { type: TransactionType; amount: number }[] = [
    { type: importRow('Credit', 'Square Inc SQ260701 T3NX9297RYCZXP3', 54_737), amount: 54_737 },
    { type: importRow('Credit', 'DEPOSIT', 36_414), amount: 36_414 },
    { type: importRow('Debit', 'Sysco Corporatio PURCHASE USBLXXXXX5794S', 23_790), amount: 23_790 },
    { type: importRow('Debit', 'Square Inc PAYROLL T3NJ89WAA0S6DJ0', 12_720), amount: 12_720 },
  ]
  let inflow = 0
  let outflow = 0
  for (const r of rows) {
    if (r.type === 'income') inflow += r.amount
    else if (SPEND_TYPES.includes(r.type)) outflow += r.amount
    else if (SPEND_OFFSET_TYPES.includes(r.type)) outflow -= r.amount
  }
  check('deposits land in cash in', inflow, 91_151)
  check('costs land in cash out', outflow, 36_510)
  ok('cash out is never negative from deposits alone', outflow > 0, `outflow ${outflow}`)

  // What the old code produced, kept as the thing we must never regress to.
  const legacyType = (t: string) =>
    ['expense', 'payment', 'credit', 'refund', 'transfer', 'fee', 'interest', 'income'].includes(t)
      ? (t as TransactionType)
      : null
  ok(
    'the old code really did accept "credit" as a type',
    legacyType('credit') === 'credit' && trustedStatementType('credit') === null,
  )
}

// ---------------------------------------------------------------------------
console.log('')
console.log('— summarizeImportDirection: catches an inverted statement —')
{
  // The live trap. An Amex export lists purchases as POSITIVE. Imported under the
  // `bank` convention (which means "negative = money out") the sign is left alone, so
  // every purchase reads as money IN and `inferTransactionType` returns 'income'.
  //
  // Crucially this does not error. The import succeeds and quietly converts spending
  // into revenue, which is why the guard has to inspect the OUTCOME.
  const amexRows = [
    { description: 'TRACTOR SUPPLY', raw: 412.55 },
    { description: 'SHELL OIL', raw: 96.4 },
    { description: 'GRAINGER', raw: 1204.19 },
    { description: 'AMAZON MKTPL', raw: 87.33 },
    { description: 'JOHN DEERE PARTS', raw: 655.02 },
    { description: 'VERIZON WIRELESS', raw: 214.87 },
  ]

  const asBank = amexRows.map((r) => {
    const signed = canonicalizeSign(r.raw, 'bank')
    return {
      transactionType: inferTransactionType(
        normalizeDescription(r.description),
        signed,
        r.description,
      ),
      amount: signed,
    }
  })

  const wrong = summarizeImportDirection(asBank)
  check('every purchase became income', wrong.incomeCount, 6)
  check('nothing counted as spending', wrong.expenseCount, 0)
  ok('the guard fires', wrong.looksInverted === true)
  // The whole file would have been added to revenue. Stating the dollar figure is the
  // point: "6 rows look odd" is ignorable, "$2,670 of revenue that does not exist" is
  // not.
  ok(
    'income total is the full file',
    Math.abs(wrong.incomeTotal - 2670.36) < 0.01,
    String(wrong.incomeTotal),
  )

  // Same rows under the correct convention: all spending, guard silent.
  const asCard = amexRows.map((r) => {
    const signed = canonicalizeSign(r.raw, 'card')
    return {
      transactionType: inferTransactionType(
        normalizeDescription(r.description),
        signed,
        r.description,
      ),
      amount: signed,
    }
  })

  const right = summarizeImportDirection(asCard)
  check('all six are spending', right.expenseCount, 6)
  check('no phantom income', right.incomeCount, 0)
  ok('the guard stays quiet', right.looksInverted === false)
  ok(
    'spending total is the full file',
    Math.abs(right.expenseTotal - 2670.36) < 0.01,
    String(right.expenseTotal),
  )
}

// ---------------------------------------------------------------------------
console.log('')
console.log('— summarizeImportDirection: does not cry wolf —')
{
  // A deposit-heavy but legitimate checking export must NOT trip the guard, or the
  // warning becomes noise and gets ignored on the day it is right.
  const mixed = [
    { transactionType: 'income', amount: 5000 },
    { transactionType: 'income', amount: 3200 },
    { transactionType: 'income', amount: 1800 },
    { transactionType: 'expense', amount: -450 },
    { transactionType: 'expense', amount: -220 },
    { transactionType: 'expense', amount: -90 },
  ]
  const m = summarizeImportDirection(mixed)
  ok('a real mix is not flagged', m.looksInverted === false)
  check('income share is exactly half', m.incomeShare, 0.5)

  // A tiny all-income file is a plausible pair of deposits, not evidence of inversion.
  const twoDeposits = [
    { transactionType: 'income', amount: 5000 },
    { transactionType: 'income', amount: 2500 },
  ]
  ok('2 rows are too few to judge', summarizeImportDirection(twoDeposits).looksInverted === false)

  // No rows: nothing to claim, so no share and no accusation.
  const empty = summarizeImportDirection([])
  check('no share without rows', empty.incomeShare, null)
  ok('empty is never flagged', empty.looksInverted === false)
}

console.log('')
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
