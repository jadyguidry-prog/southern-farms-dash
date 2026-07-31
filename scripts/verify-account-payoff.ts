/**
 * Regression tests for account-payoff detection.
 *
 * `normalizeDescription` strips card issuer names as merchant noise, so
 * "AMEX EPAYMENT ACH PMT A5184" becomes "EPAYMENT ACH PMT A5184" — losing the
 * one word that identified it as a card payoff. It then fell through to
 * `expense`, counting 9 AMEX payoffs as $36,354 of vendor spend even though the
 * underlying purchases were separately imported from the card statement. That
 * double-counted the money and put a bogus "top vendor" at the head of the
 * categorize queue.
 *
 * The fix checks the RAW line, and requires an issuer AND payoff wording
 * together so ordinary vendor purchases are never swept up. These tests pin both
 * halves of that: real payoffs are caught, look-alike purchases are not.
 */

import {
  inferTransactionType,
  looksLikeAccountPayoff,
  normalizeDescription,
  SPEND_TYPES,
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
    console.log(`  FAIL ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`)
  }
}

/** Classify the way the importer does: normalize first, pass raw alongside. */
function classify(raw: string, signed: number) {
  return inferTransactionType(normalizeDescription(raw), signed, raw)
}

console.log('\n-- the real statement lines that were misread --')

// These are the exact descriptions from the owner's data.
for (const raw of [
  'AMEX EPAYMENT ACH PMT A5184',
  'AMEX EPAYMENT ACH PMT A3794',
  'Epayment Ach Pmt A3794',
]) {
  check(`"${raw}" is a payment, not spend`, classify(raw, -1000), 'payment')
}

check(
  'the regression itself: normalized form has lost "AMEX"',
  normalizeDescription('AMEX EPAYMENT ACH PMT A5184').includes('AMEX'),
  false,
)

// The two-payoff-phrase rule is strong enough to recover this line even after
// the issuer has been stripped, so the fix does not depend on the caller
// remembering to pass the raw description. Belt and braces.
check(
  'still caught even without the raw line (issuer already stripped)',
  inferTransactionType(normalizeDescription('AMEX EPAYMENT ACH PMT A5184'), -1000),
  'payment',
)

console.log('\n-- payment is excluded from spend --')

check('payment is not a spend type', SPEND_TYPES.includes('payment' as never), false)
check('transfer is not a spend type', SPEND_TYPES.includes('transfer' as never), false)
check('expense IS a spend type', SPEND_TYPES.includes('expense'), true)

console.log('\n-- explicit card / loan wording still works --')

for (const raw of [
  'CARD PAYMENT',
  'CREDIT CARD PAYMENT',
  'LOAN PAYMENT',
  'Loan Payment',
  'MORTGAGE PMT',
  'LOAN PMT 4471',
]) {
  check(`"${raw}" is a payment`, classify(raw, -500), 'payment')
}

console.log('\n-- other issuers and payoff wordings --')

for (const raw of [
  'CHASE CREDIT CRD EPAY',
  'DISCOVER E-PAYMENT 8842',
  'CAPITAL ONE AUTOPAY',
  'CITIBANK ONLINE PAYMENT',
  'SYNCHRONY BANK BILL PAY',
  'AMERICAN EXPRESS ACH PMT',
]) {
  check(`"${raw}" is a payment`, classify(raw, -500), 'payment')
}

console.log('\n-- look-alikes that must NOT be swept up --')

// An issuer name alone is a purchase (buying something at a bank branch, or a
// merchant whose name contains an issuer word).
check('"VISA PURCHASE FEED STORE" stays spend', classify('VISA PURCHASE FEED STORE', -80), 'expense')
check('"CHASE FARM SUPPLY" stays spend', classify('CHASE FARM SUPPLY', -120), 'expense')

// Payoff wording alone, with no issuer, is an ordinary vendor payment.
check('"ONLINE PAYMENT TRACTOR CO" stays spend', classify('ONLINE PAYMENT TRACTOR CO', -300), 'expense')
check('"BILL PAY ENTERGY" stays spend', classify('BILL PAY ENTERGY', -450), 'expense')
check('"AUTOPAY VERIZON" stays spend', classify('AUTOPAY VERIZON', -90), 'expense')

check('looksLikeAccountPayoff needs both halves', looksLikeAccountPayoff('AMEX FEED STORE'), false)
check('looksLikeAccountPayoff on issuer+payoff', looksLikeAccountPayoff('AMEX EPAYMENT'), true)

console.log('\n-- existing behaviour is preserved --')

check('interest still wins', classify('INTEREST CHARGE', -12), 'interest')
check('fee still wins', classify('MONTHLY FEE', -15), 'fee')
check('transfer still wins', classify('TRANSFER TO SAVINGS', -2000), 'transfer')
check('refund still wins', classify('REFUND FROM VENDOR', 75), 'refund')
check('deposit in is income', classify('SALES DEPOSIT', 5000), 'income')
check('unknown money out is expense', classify('SOME FEED STORE', -60), 'expense')
check('unknown money in is income', classify('SOMETHING ELSE', 60), 'income')

console.log('\n-- edge cases --')

check('empty description', looksLikeAccountPayoff(''), false)
check('null-ish description', looksLikeAccountPayoff(undefined as unknown as string), false)
check('lowercase raw still matches', looksLikeAccountPayoff('amex epayment ach pmt'), true)
check(
  'omitting rawDescription keeps the old 2-arg signature working',
  inferTransactionType('LOAN PAYMENT', -100),
  'payment',
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
