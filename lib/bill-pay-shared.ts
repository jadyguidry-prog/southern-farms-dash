// Pure Bill Pay logic shared by the server and the client.
//
// This module exists to stay import-safe from a 'use client' component:
// lib/bill-pay-service.ts imports the Supabase server client (which reads
// next/headers), so importing a VALUE from it in a client component drags
// server-only code into the browser bundle and breaks the build. Type-only
// imports are erased and remain safe.
//
// Nothing here may import a database client, next/headers, or any server module.

/** Minimal shape these helpers need; the full type lives in bill-pay-service. */
type LabelablePayment = {
  obligationId: string | null
  payeeName: string
}

/**
 * The label to show for a payment. A one-off check has no obligation to borrow a
 * name from, so it falls back to its payee — and never to a bare id or an empty
 * string, since an unlabelled row in a cash ledger is worse than useless.
 */
export function paymentLabel(
  p: LabelablePayment,
  obligationNames: Map<string, string>,
): string {
  if (p.obligationId) return obligationNames.get(p.obligationId) ?? 'Scheduled bill'
  return p.payeeName || 'One-off payment'
}

/**
 * The validation rules every payment must satisfy, regardless of whether it is
 * paid against a scheduled bill or written as a one-off. Shared so the two entry
 * points cannot drift apart — a one-off check must be held to the same standard
 * as a scheduled one, or the outstanding total becomes unreliable.
 *
 * Returns an error message, or null when the input is acceptable.
 */
export function validatePaymentBasics(
  input: {
    amount: number
    paymentDate: string
    paymentMethod: string
    checkNumber?: string
  },
  opts: {
    /**
     * Permit `check` with no number yet — for logging a bill that WILL be paid by
     * check before the check is actually written. Defaults to false so the
     * "Write a Check" path keeps the strict rule; only invoice logging opts in.
     */
    allowUnwrittenCheck?: boolean
  } = {},
): string | null {
  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return 'Enter a payment amount greater than zero.'
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate ?? '')) {
    return 'Choose a valid payment date.'
  }
  if (input.paymentMethod !== 'check' && input.paymentMethod !== 'ach') {
    return 'Choose check or ACH.'
  }
  // A written check with no number cannot be matched to the bank feed later, which
  // is the whole reason the float number can be trusted. Same rule as
  // check-resolution. An invoice logged before the check exists is exempt: the
  // number is captured later, when the check is actually written.
  if (
    input.paymentMethod === 'check' &&
    !opts.allowUnwrittenCheck &&
    !(input.checkNumber ?? '').trim()
  ) {
    return 'Enter the check number.'
  }
  return null
}

/**
 * Is this payment still WAITING to leave the bank, with no physical instrument in
 * existence yet?
 *
 * Two cases, both "money promised, nothing written":
 *   - an ACH draft that hasn't been taken yet, and
 *   - a bill logged as pay-by-check, before the check is written.
 *
 * Both must be described as "expected", never "written".
 *
 * Keyed on `checkWritten`, NOT on a missing check number. A written check whose
 * number simply wasn't recorded is still written: its payment date is a fact, so it
 * stays eligible for amount+date bank matching. Only an unwritten check has a date
 * that is merely an intention. Conflating the two would silently change matching
 * behaviour for checks the owner wrote but didn't fully log.
 *
 * Note this deliberately does NOT change the cash math: `sumOutstanding` counts
 * every outstanding row regardless, which is correct — the money is owed and the
 * bank balance still includes it either way.
 */
export function isAwaitingPayment(p: {
  paymentMethod: string
  checkWritten?: boolean
}): boolean {
  if (p.paymentMethod === 'ach') return true
  // Absent flag means "written": matches the column default, so a caller reading an
  // older row (or a partial object) never gets silently downgraded to unwritten.
  return p.checkWritten === false
}

// ---------------------------------------------------------------------------
// Automatic reconciliation of autopay/ACH bills from the checking feed.
//
// An ACH bill (cash_obligations.payment_method = 'ACH') is paid by an automatic
// bank draft, so there is no float and nothing to record by hand — the truth is
// the debit itself. This matcher finds the bank debit that paid each ACH bill so
// the caller can mark it cleared on the ACTUAL posted date.
//
// Safety is the whole game here: a FALSE match silently marks the wrong bill
// paid, which is worse than doing nothing, whereas a MISS just leaves a bill
// scheduled for the owner to handle. So every rule below fails toward "no match":
//   * The vendor name must appear in the bank description (the strong key). Amount
//     alone is NOT enough — several bills collide on amount (that is exactly why
//     those bills are paid by check and excluded here).
//   * Amount is only a loose secondary guard, because variable utilities never
//     clear at the scheduled figure (Entergy scheduled 2,200 -> drafted 2,193.23).
//   * A transaction already linked to any payment is never reused (the DB unique
//     index on cleared_transaction_id is the backstop).
//
// Matching deliberately keys on vendor + amount, NOT on proximity to next_due_date:
// today can sit before the current due date while real prior-period debits already
// exist in history, and each qualifying debit is a genuine payment. next_due_date
// is used only by the caller to roll the schedule forward.
// ---------------------------------------------------------------------------

// Loose amount guard, within 20% or $50 (whichever is larger). Calibrated against
// the real feed: electric drafts ran 1,926 -> 2,470 against a 2,200 schedule (a
// ±12.5% seasonal swing), so a tighter band would MISS real utility bills — the
// exact debits we most want to catch. The band's only job is to reject a same-named
// row that is plainly not the monthly bill (a $2 fee, a one-off equipment payment);
// the vendor name in the description is the real identifier.
export const ACH_AMOUNT_TOLERANCE_PCT = 0.2
export const ACH_AMOUNT_TOLERANCE_FLOOR = 50
/** How far back to scan the ledger. Bounds the query and avoids reviving ancient rows. */
export const ACH_LOOKBACK_DAYS = 100

export type AchObligationInput = {
  id: string
  obligationName: string
  vendorName: string
  amount: number
  frequency: string
  nextDueDate: string
  recurring: boolean
  active: boolean
  paymentMethod: string
}

export type AchTxnInput = {
  id: string
  transaction_date: string | null
  amount: number | string | null
  description: string | null
  transaction_type: string | null
}

export type AchReconcileMatch = {
  obligationId: string
  obligationName: string
  vendorName: string
  transactionId: string
  amount: number
  postedDate: string
  description: string
}

/** Uppercase and reduce to alphanumeric tokens so "Pelican Waste" matches "PELICAN WASTE AN". */
function normalizeText(s: string): string {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
}

/** Distinctive tokens of a vendor name — short filler ("of", "&") is dropped. */
export function vendorTokens(vendorName: string): string[] {
  return normalizeText(vendorName)
    .split(' ')
    .filter((t) => t.length >= 3)
}

/**
 * Does the bank description identify this vendor? Requires EVERY distinctive token
 * of the vendor name to be present — strict on purpose, since a false positive is
 * the dangerous outcome. Returns false when the vendor name yields no usable token,
 * so an unnamed bill can never auto-match on amount alone.
 */
export function descriptionMatchesVendor(vendorName: string, description: string): boolean {
  const tokens = vendorTokens(vendorName)
  if (tokens.length === 0) return false
  const desc = normalizeText(description)
  if (!desc) return false
  return tokens.every((t) => desc.includes(t))
}

export function amountWithinAchTolerance(scheduled: number, actual: number): boolean {
  const tol = Math.max(scheduled * ACH_AMOUNT_TOLERANCE_PCT, ACH_AMOUNT_TOLERANCE_FLOOR)
  return Math.abs(actual - scheduled) <= tol
}

function daysBetween(fromISO: string, toISO: string): number {
  return (
    (new Date(toISO + 'T00:00:00').getTime() - new Date(fromISO + 'T00:00:00').getTime()) /
    86_400_000
  )
}

/**
 * Pure matcher: given the ACH obligations, candidate bank rows, the transaction ids
 * already linked to a payment, and today, return the debits that should be marked
 * paid. One bank transaction is claimed at most once. An obligation may match more
 * than one debit (each prior period is its own real payment), which backfills
 * history and keeps working as new debits post.
 */
export function buildAchReconcileMatches(
  obligations: AchObligationInput[],
  transactions: AchTxnInput[],
  linkedTransactionIds: Iterable<string>,
  today: string,
): AchReconcileMatch[] {
  const used = new Set(linkedTransactionIds)
  const claimed = new Set<string>()

  const eligible = obligations.filter(
    (o) =>
      o.active &&
      o.recurring &&
      o.paymentMethod.toUpperCase() === 'ACH' &&
      vendorTokens(o.vendorName).length > 0,
  )

  // Only outgoing rows, no future-dated rows, and nothing older than the lookback.
  const candidates = transactions
    .filter((t) => {
      const type = (t.transaction_type ?? '').toLowerCase()
      if (type !== 'expense' && type !== 'payment') return false
      const d = (t.transaction_date ?? '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
      if (d > today) return false
      if (daysBetween(d, today) > ACH_LOOKBACK_DAYS) return false
      return !used.has(t.id)
    })
    // Newest first so the most recent period is presented first.
    .sort((a, b) => (b.transaction_date ?? '').localeCompare(a.transaction_date ?? ''))

  const matches: AchReconcileMatch[] = []
  // Larger bills first: with distinct ACH amounts this makes assignment deterministic
  // and keeps a small bill from claiming a large bill's debit on a loose tolerance.
  const ordered = [...eligible].sort((a, b) => b.amount - a.amount)

  for (const o of ordered) {
    for (const t of candidates) {
      if (claimed.has(t.id)) continue
      const amt = Number(t.amount) || 0
      if (!descriptionMatchesVendor(o.vendorName, t.description ?? '')) continue
      if (!amountWithinAchTolerance(o.amount, amt)) continue
      claimed.add(t.id)
      matches.push({
        obligationId: o.id,
        obligationName: o.obligationName,
        vendorName: o.vendorName,
        transactionId: t.id,
        amount: amt,
        postedDate: (t.transaction_date ?? '').slice(0, 10),
        description: t.description ?? '',
      })
    }
  }

  return matches.sort((a, b) => b.postedDate.localeCompare(a.postedDate))
}
