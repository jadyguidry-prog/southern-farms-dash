import type { Transaction as PlaidTransaction } from 'plaid'
import {
  canonicalizeSign,
  duplicateKey,
  inferTransactionType,
  normalizeDescription,
  type AmountConvention,
} from './transactions'

/**
 * How a Plaid account maps onto a row in `financial_transactions`.
 *
 * `accountName` MUST be the exact string already stored on existing rows for that
 * account (e.g. "South Lafourche Bank Checking ending 2268"). There is no
 * account_id FK in this schema — accounts are joined by that free-text label — so
 * a near-miss silently creates a second account and splits every per-account
 * report in two.
 */
export type PlaidAccountMapping = {
  accountId: string
  accountName: string
  /** Plaid reports money-out as positive, so this is 'card' for every account. */
  amountConvention: AmountConvention
  /**
   * Skip anything dated before this day. The CSV history and Plaid disagree on
   * transaction ids, merchant names, and account labels, so overlapping rows would
   * NOT be caught by duplicateKey's natural-key fallback and would double-count.
   */
  importFromDate: string | null
  isEnabled: boolean
}

export type MappedTransaction = {
  transaction_date: string
  description: string
  normalized_description: string
  amount: number
  transaction_type: string
  account_name: string
  source: string
  external_transaction_id: string
  check_number: string | null
  statement_month: string | null
}

/**
 * Whether Plaid still considers this transaction pending.
 *
 * NOT persisted: `financial_transactions` has no is_pending column, and adding one
 * would mean touching a table the whole app reads. The sync uses this in-memory to
 * decide whether a row is worth re-checking, and Plaid's own `modified` list tells
 * us when a pending row settles.
 */
export function isPending(t: PlaidTransaction): boolean {
  return Boolean(t.pending)
}

/** `YYYY-MM-DD` -> `YYYY-MM-01`, matching the statement_month convention. */
function statementMonthOf(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? `${date.slice(0, 7)}-01` : null
}

/**
 * Plaid's own sign convention, stated once so the reasoning is not re-derived at
 * every call site.
 *
 * Plaid documents `amount` as "positive values when money moves OUT of the
 * account; negative values when money moves IN". This app's canonical convention
 * is the exact inverse: NEGATIVE means money out. That inversion is the same class
 * of bug that produced the -$96,116 expense chart from a mis-mapped CSV, so rather
 * than hand-rolling a flip here we reuse `canonicalizeSign(amount, 'card')`, which
 * already encodes "positive means money out" and is covered by existing tests.
 */
export const PLAID_AMOUNT_CONVENTION: AmountConvention = 'card'

/**
 * Best human-readable description for a Plaid transaction.
 *
 * `merchant_name` is Plaid's cleaned merchant ("Sysco") and is preferred because it
 * feeds vendor matching and category learning far better than the raw bank line
 * ("SYSCO 8887 0000123456 ACH"). `name` is the fallback, since merchant_name is
 * null for non-merchant activity like transfers and check payments.
 */
export function describeTransaction(t: PlaidTransaction): string {
  const merchant = (t.merchant_name ?? '').trim()
  const name = (t.name ?? '').trim()
  return merchant || name || 'Unknown transaction'
}

/**
 * Convert one Plaid transaction into an insertable row, or null when it must be
 * skipped.
 *
 * Returns null for: disabled accounts, unmapped accounts, and anything dated
 * before the account's cutover. Skipping is silent by design at this layer; the
 * sync counts and reports them.
 */
export function mapTransaction(
  t: PlaidTransaction,
  mapping: PlaidAccountMapping | undefined,
): MappedTransaction | null {
  if (!mapping || !mapping.isEnabled) return null

  const date = (t.date ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null

  // The cutover guard. Plaid returns up to 24 months of history on first sync, so
  // without this the initial run would re-import everything already loaded from
  // CSV under different ids.
  if (mapping.importFromDate && date < mapping.importFromDate) return null

  const description = describeTransaction(t)
  const normalized = normalizeDescription(description)
  const amount = canonicalizeSign(Number(t.amount), mapping.amountConvention)

  return {
    transaction_date: date,
    description,
    normalized_description: normalized,
    amount,
    transaction_type: inferTransactionType(normalized, amount, description),
    account_name: mapping.accountName,
    source: 'plaid',
    external_transaction_id: t.transaction_id,
    check_number: t.check_number ? String(t.check_number) : null,
    statement_month: statementMonthOf(date),
  }
}

/** The dedupe key for a mapped row — always the Plaid id, which is stable. */
export function mappedDuplicateKey(row: MappedTransaction): string {
  return duplicateKey({
    transaction_date: row.transaction_date,
    amount: row.amount,
    normalized_description: row.normalized_description,
    account_name: row.account_name,
    external_transaction_id: row.external_transaction_id,
  })
}

/**
 * Default account label for a newly linked Plaid account, used only to prefill the
 * Settings mapping field. Deliberately NOT auto-applied to transactions: the owner
 * must confirm it matches an existing account name before any import runs.
 */
export function suggestAccountName(
  plaidName: string | null | undefined,
  mask: string | null | undefined,
): string {
  const base = (plaidName ?? '').trim() || 'Account'
  return mask ? `${base} ending ${mask}` : base
}
