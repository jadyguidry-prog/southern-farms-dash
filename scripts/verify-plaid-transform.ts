/**
 * Guards the Plaid -> financial_transactions mapping.
 *
 * The headline risk is the sign convention: Plaid reports money-out as POSITIVE,
 * this app stores money-out as NEGATIVE. Getting that backwards is exactly what
 * produced the -$96,116 expense chart from a mis-mapped CSV, so it is asserted
 * from both directions here. The second risk is the cutover date, which is all
 * that stands between a first sync and re-importing 1,434 CSV rows under new ids.
 */
import type { Transaction as PlaidTransaction } from 'plaid'
import {
  PLAID_AMOUNT_CONVENTION,
  describeTransaction,
  isPending,
  mapTransaction,
  mappedDuplicateKey,
  suggestAccountName,
  type PlaidAccountMapping,
} from '../lib/plaid-transform'
import { encryptToken, decryptToken, tokenHint } from '../lib/plaid-crypto'

let passed = 0
let failed = 0

function ok(label: string, condition: boolean) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}`)
  }
}

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`)
  }
}

const CHECKING: PlaidAccountMapping = {
  accountId: 'acc_checking',
  accountName: 'South Lafourche Bank Checking ending 2268',
  amountConvention: PLAID_AMOUNT_CONVENTION,
  importFromDate: '2026-08-01',
  isEnabled: true,
}

const AMEX: PlaidAccountMapping = {
  accountId: 'acc_amex',
  accountName: 'American Express Business Gold ending 0-73009',
  amountConvention: PLAID_AMOUNT_CONVENTION,
  importFromDate: '2026-07-04',
  isEnabled: true,
}

function tx(over: Partial<PlaidTransaction>): PlaidTransaction {
  return {
    transaction_id: 'plaid_tx_1',
    account_id: 'acc_checking',
    amount: 100,
    date: '2026-08-05',
    name: 'RAW BANK LINE 0000123',
    merchant_name: null,
    pending: false,
    iso_currency_code: 'USD',
    ...over,
  } as PlaidTransaction
}

console.log('\nsign convention — Plaid positive = money OUT, app negative = money OUT')
{
  // A $250 purchase. Plaid sends +250; the ledger must store -250 or every card
  // purchase reads as income and vendor spend reports zero.
  const purchase = mapTransaction(
    tx({ amount: 250, merchant_name: 'Sysco' }),
    CHECKING,
  )
  check('a $250 purchase is stored negative', purchase?.amount, -250)
  check('a purchase is typed as expense', purchase?.transaction_type, 'expense')

  // A deposit. Plaid sends -1800.
  const deposit = mapTransaction(
    tx({ amount: -1800, name: 'DEPOSIT', merchant_name: null }),
    CHECKING,
  )
  check('an $1800 deposit is stored positive', deposit?.amount, 1800)
  check('a deposit is typed as income', deposit?.transaction_type, 'income')

  ok(
    'the two directions have opposite signs',
    (purchase?.amount ?? 0) < 0 && (deposit?.amount ?? 0) > 0,
  )

  // Regression: reusing 'card' must not be silently changed to 'bank', which
  // would pass the amount straight through and invert the whole ledger.
  check("convention is 'card' (positive = money out)", PLAID_AMOUNT_CONVENTION, 'card')
}

console.log('\ncutover dates — the guard against re-importing CSV history')
{
  ok(
    'a row before the checking cutover is skipped',
    mapTransaction(tx({ date: '2026-07-31' }), CHECKING) === null,
  )
  ok(
    'a row on the cutover date is kept',
    mapTransaction(tx({ date: '2026-08-01' }), CHECKING) !== null,
  )
  ok(
    'a row after the cutover is kept',
    mapTransaction(tx({ date: '2026-08-05' }), CHECKING) !== null,
  )
  // Amex has an earlier cutover, so the same date behaves differently per account.
  ok(
    'the Amex cutover is independent of checking',
    mapTransaction(tx({ date: '2026-07-10', account_id: 'acc_amex' }), AMEX) !==
      null,
  )
  ok(
    'a pre-Amex-cutover row is still skipped',
    mapTransaction(tx({ date: '2026-07-03', account_id: 'acc_amex' }), AMEX) ===
      null,
  )
  // No cutover set => import everything. Only correct for a brand-new account.
  ok(
    'a null cutover imports all history',
    mapTransaction(tx({ date: '2020-01-01' }), {
      ...CHECKING,
      importFromDate: null,
    }) !== null,
  )
}

console.log('\nskips and guards')
{
  ok(
    'an unmapped account is skipped',
    mapTransaction(tx({}), undefined) === null,
  )
  ok(
    'a disabled account is skipped',
    mapTransaction(tx({}), { ...CHECKING, isEnabled: false }) === null,
  )
  ok(
    'a malformed date is skipped',
    mapTransaction(tx({ date: 'not-a-date' }), CHECKING) === null,
  )
}

console.log('\ndescription — merchant_name preferred, raw line as fallback')
{
  check(
    'merchant_name wins when present',
    describeTransaction(tx({ merchant_name: 'Quirch Foods', name: 'QUIRCH 887 ACH' })),
    'Quirch Foods',
  )
  check(
    'falls back to the raw line',
    describeTransaction(tx({ merchant_name: null, name: 'CHECK 1041' })),
    'CHECK 1041',
  )
  check(
    'blank merchant_name does not win',
    describeTransaction(tx({ merchant_name: '   ', name: 'CHECK 1041' })),
    'CHECK 1041',
  )
  ok(
    'never returns an empty description',
    describeTransaction(tx({ merchant_name: null, name: '' })).length > 0,
  )
}

console.log('\ndedupe key uses the stable Plaid id')
{
  const row = mapTransaction(tx({ transaction_id: 'plaid_abc' }), CHECKING)!
  check('key is the ext: form', mappedDuplicateKey(row), 'ext:plaid_abc')

  // A settled row keeps its id but changes amount; the key must still match so the
  // sync updates rather than inserting a duplicate.
  const settled = mapTransaction(
    tx({ transaction_id: 'plaid_abc', amount: 260 }),
    CHECKING,
  )!
  check(
    'same id survives an amount change',
    mappedDuplicateKey(settled),
    'ext:plaid_abc',
  )
}

console.log('\npending flag is read but never persisted')
{
  check('pending is detected', isPending(tx({ pending: true })), true)
  check('settled is detected', isPending(tx({ pending: false })), false)

  // financial_transactions has no is_pending column. Emitting one would make every
  // insert fail, so assert the mapped row never carries it.
  const row = mapTransaction(tx({ pending: true }), CHECKING)!
  ok('mapped row has no is_pending key', !('is_pending' in row))

  // Every emitted key must be a real column, or the whole batch is rejected.
  const COLUMNS = new Set([
    'transaction_date',
    'description',
    'normalized_description',
    'amount',
    'transaction_type',
    'account_name',
    'source',
    'external_transaction_id',
    'check_number',
    'statement_month',
  ])
  const unknown = Object.keys(row).filter((k) => !COLUMNS.has(k))
  check('every mapped key is a real column', unknown, [])
}

console.log('\nrow shape')
{
  const row = mapTransaction(
    tx({ date: '2026-08-05', merchant_name: 'Sysco', amount: 412.5 }),
    CHECKING,
  )!
  check('source is plaid', row.source, 'plaid')
  check(
    'account name is the exact stored label',
    row.account_name,
    'South Lafourche Bank Checking ending 2268',
  )
  check('statement_month is the 1st', row.statement_month, '2026-08-01')
  check('amount keeps cents', row.amount, -412.5)
  ok('normalized description is set', row.normalized_description.length > 0)
  check(
    'check_number is extracted when Plaid supplies it',
    mapTransaction(tx({ check_number: '1041' }), CHECKING)?.check_number,
    '1041',
  )
  check(
    'check_number is null otherwise',
    mapTransaction(tx({}), CHECKING)?.check_number,
    null,
  )
}

console.log('\naccount label suggestion')
{
  check(
    'appends the mask',
    suggestAccountName('Plaid Checking', '2268'),
    'Plaid Checking ending 2268',
  )
  check('handles a missing mask', suggestAccountName('Plaid Checking', null), 'Plaid Checking')
  check('handles a missing name', suggestAccountName(null, '2268'), 'Account ending 2268')
}

console.log('\ntoken encryption')
{
  process.env.PLAID_ENCRYPTION_KEY =
    process.env.PLAID_ENCRYPTION_KEY ?? 'test-key-for-verification-only'

  const secret = 'access-sandbox-abc123-def456'
  const sealed = encryptToken(secret)

  ok('ciphertext does not contain the token', !sealed.includes(secret))
  ok('ciphertext is versioned', sealed.startsWith('v1.'))
  check('round-trips exactly', decryptToken(sealed), secret)

  // GCM must reject tampering rather than return garbage we would send to Plaid.
  let rejected = false
  try {
    const parts = sealed.split('.')
    const body = Buffer.from(parts[3], 'base64')
    body[0] ^= 0xff
    parts[3] = body.toString('base64')
    decryptToken(parts.join('.'))
  } catch {
    rejected = true
  }
  ok('tampered ciphertext is rejected', rejected)

  let rejectedFormat = false
  try {
    decryptToken('not-encrypted-at-all')
  } catch {
    rejectedFormat = true
  }
  ok('unencrypted input is rejected', rejectedFormat)

  ok('two encryptions differ (random iv)', encryptToken(secret) !== encryptToken(secret))
  check('token hint shows only the tail', tokenHint(secret), '****f456')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
