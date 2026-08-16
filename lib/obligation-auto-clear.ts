// Matching bank checks to the bills they paid.
//
// WHY THIS EXISTS
// The ACH reconciler (lib/bill-pay-shared.ts) identifies a bank debit by finding the
// vendor's name inside the bank description. That is a strong key, and it works well
// for drafts. It cannot work for a check: the bank tells us only "CHECK 1670" — no
// payee, no memo, nothing about who was paid. So every check-paid bill was structurally
// excluded from automatic reconciliation, which is most of this business's bills.
//
// A check has something better than a name, though: the check NUMBER is a unique
// identifier the owner already records when writing the check. Number + exact amount is
// about as certain as reconciliation ever gets, so that pairing (and only that pairing)
// is safe to act on without asking.
//
// THE RULE EVERYTHING FOLLOWS
// A false match silently marks the wrong bill paid and understates real debt. A miss
// just leaves a bill on the list for the owner. So every rule fails toward "ask", and
// only tier 1 is ever written automatically.
//
// This module is PURE — no database, no clock, no next/headers — so it is import-safe
// from a client component and fully testable without a database. `todayISO` is passed
// in by the impure caller, following bill-pay-shared.ts.

/** Direction lives in transaction_type; amounts are stored POSITIVE in this app. */
const OUTGOING_TYPES = new Set(['expense', 'payment'])

/**
 * Money is compared as integer cents. Two values that print identically as dollars can
 * differ in binary float (a stored 5025.7 reads back as 5025.7000000000003), and an
 * "exact amount" tier that is defeated by float noise would silently demote certain
 * matches into the review queue — the failure would look like caution, not a bug.
 */
export function cents(n: number | string | null | undefined): number {
  return Math.round((Number(n) || 0) * 100)
}

export type AutoClearObligation = {
  id: string
  obligationName: string
  vendorName: string
  amount: number
  status: string
  active: boolean
  paymentMethod: string
}

export type AutoClearPayment = {
  id: string
  obligationId: string | null
  status: string
  checkNumber: string | null
  amount: number
  paymentDate: string
  payee: string
}

export type AutoClearTxn = {
  id: string
  transaction_date: string | null
  amount: number | string | null
  description: string | null
  check_number: string | null
  transaction_type: string | null
  /**
   * Set once the owner has confirmed this bank row does not pay any tracked bill.
   * Without persisting that decision the same check would reappear on every sync, and a
   * queue that keeps re-asking the same question is one the owner stops reading.
   */
  bill_match_dismissed_at?: string | null
}

/** A pairing certain enough to write without asking. */
export type AutoClearMatch = {
  paymentId: string
  transactionId: string
  checkNumber: string
  amount: number
  postedDate: string
  /** For the audit detail and the "what changed" summary. */
  label: string
}

export type ReviewReason =
  | 'amount_mismatch'
  | 'ambiguous_amount'
  | 'possible_unrecorded_payment'
  | 'unrecognized_check'

export type AutoClearReview = {
  transactionId: string
  checkNumber: string | null
  bankAmount: number
  postedDate: string
  description: string
  reason: ReviewReason
  /** Plain English, shown verbatim in the UI. No jargon, no codes. */
  explanation: string
  /** The payment this bank row appears to clear, when one exists. */
  paymentId?: string
  /** Obligations this row might have paid. More than one entry means genuinely ambiguous. */
  candidateObligationIds: string[]
  /** What the owner recorded, when a payment row exists — for the amount comparison. */
  recordedAmount?: number
}

export type AutoClearResult = {
  autoClear: AutoClearMatch[]
  review: AutoClearReview[]
}

/**
 * The check number for a bank row. Prefers the dedicated column and falls back to
 * parsing the description, because this ledger holds rows from three sources (CSV
 * import, Plaid, hand entry) and only some populate check_number.
 *
 * Requires the digits to be introduced by the word CHECK/CHK/CK. A bare number in a
 * description is far more likely an invoice or account number, and treating one as a
 * check number is exactly the kind of confident wrong answer this module must avoid.
 */
export function checkNumberOf(txn: {
  check_number?: string | null
  description?: string | null
}): string | null {
  const col = (txn.check_number ?? '').trim()
  if (col) {
    const digits = col.replace(/\D+/g, '')
    if (digits) return String(Number(digits))
  }
  const m = (txn.description ?? '').match(/\b(?:CHECK|CHK|CK)\s*#?\s*(\d{2,7})\b/i)
  if (m) return String(Number(m[1]))
  return null
}

function isOutgoing(txn: AutoClearTxn): boolean {
  return OUTGOING_TYPES.has((txn.transaction_type ?? '').toLowerCase())
}

function dayDiff(fromISO: string, toISO: string): number {
  return (
    (new Date(toISO + 'T00:00:00').getTime() - new Date(fromISO + 'T00:00:00').getTime()) /
    86_400_000
  )
}

function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export type ClassifyOptions = {
  /**
   * How far back to surface a bank check that matched nothing. There are ~198 cleared
   * checks in this ledger going back to May 2025, nearly all ordinary spending that was
   * never tracked as a bill; surfacing them all would open the queue with 198 rows of
   * settled history and bury the few that matter. Older checks remain in Check
   * Resolution, where they already live.
   */
  orphanReviewDays: number
  /** How far back to consider a check for clearing at all. Bounds the whole pass. */
  clearWindowDays: number
}

/**
 * Decide what the bank's checks say about the bills on record.
 *
 * Returns pairings certain enough to write (`autoClear`) and everything else with a
 * reason the owner can act on (`review`). Never mutates its inputs; never guesses.
 */
export function classifyClearCandidates(
  obligations: AutoClearObligation[],
  payments: AutoClearPayment[],
  transactions: AutoClearTxn[],
  linkedTransactionIds: Iterable<string>,
  todayISO: string,
  opts: ClassifyOptions,
): AutoClearResult {
  const linked = new Set(linkedTransactionIds)

  // Bank rows in scope: outgoing, real date, not future, inside the window, carrying a
  // check number, and not already used as evidence for some other payment.
  const bankChecks = transactions
    .filter((t) => {
      if (!isOutgoing(t)) return false
      if (linked.has(t.id)) return false
      const d = (t.transaction_date ?? '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
      if (d > todayISO) return false
      if (dayDiff(d, todayISO) > opts.clearWindowDays) return false
      return checkNumberOf(t) !== null
    })
    .sort((a, b) => (b.transaction_date ?? '').localeCompare(a.transaction_date ?? ''))

  // An amount shared by two or more bank checks cannot identify a bill on its own.
  // Counted across the whole window, not just unmatched rows, so a repeated weekly
  // amount is recognised as repeated.
  const bankAmountCounts = new Map<number, number>()
  for (const t of bankChecks) {
    const c = cents(t.amount)
    bankAmountCounts.set(c, (bankAmountCounts.get(c) ?? 0) + 1)
  }

  // Payments still awaiting bank confirmation, indexed by check number. A cleared or
  // void payment is finished and must never be touched again.
  const outstandingByCheck = new Map<string, AutoClearPayment[]>()
  for (const p of payments) {
    if (p.status !== 'outstanding') continue
    const num = (p.checkNumber ?? '').replace(/\D+/g, '')
    if (!num) continue
    const key = String(Number(num))
    const list = outstandingByCheck.get(key) ?? []
    list.push(p)
    outstandingByCheck.set(key, list)
  }

  const obligationNames = new Map(obligations.map((o) => [o.id, o.obligationName]))

  // Bills that are genuinely still owed and have NO payment row at all. This is the gap
  // the existing suggestion engine cannot cover: it only looks at outstanding payments,
  // so a bill paid by a check that was never hand-recorded can never be matched.
  const paidObligationIds = new Set(
    payments.filter((p) => p.status !== 'void').map((p) => p.obligationId).filter(Boolean),
  )
  const unpaidWithoutPayment = obligations.filter(
    (o) => o.active && o.status !== 'Paid' && !paidObligationIds.has(o.id),
  )

  // An amount shared by two or more open bills cannot be resolved by amount either.
  // Real case: two Owner Draw bills are both exactly $1,500.00 (Jady, Trent). Amount
  // alone cannot say which one a $1,500 check paid, so the app must not choose.
  const obligationAmountCounts = new Map<number, number>()
  for (const o of unpaidWithoutPayment) {
    const c = cents(o.amount)
    obligationAmountCounts.set(c, (obligationAmountCounts.get(c) ?? 0) + 1)
  }

  const autoClear: AutoClearMatch[] = []
  const review: AutoClearReview[] = []
  const claimedPayments = new Set<string>()

  for (const t of bankChecks) {
    const num = checkNumberOf(t)
    if (!num) continue
    const bankAmt = Number(t.amount) || 0
    const postedDate = (t.transaction_date ?? '').slice(0, 10)
    const description = t.description ?? ''

    const candidates = (outstandingByCheck.get(num) ?? []).filter(
      (p) => !claimedPayments.has(p.id),
    )

    // --- Tier 1 / 2: the owner recorded this check number ---
    if (candidates.length > 0) {
      // Two outstanding payments sharing a check number is a data problem, not
      // something to resolve by picking one.
      if (candidates.length > 1) {
        review.push({
          transactionId: t.id,
          checkNumber: num,
          bankAmount: bankAmt,
          postedDate,
          description,
          reason: 'ambiguous_amount',
          explanation: `More than one recorded payment claims check #${num}. Open them and correct the duplicate before this can clear.`,
          candidateObligationIds: candidates
            .map((p) => p.obligationId)
            .filter((x): x is string => Boolean(x)),
        })
        continue
      }

      const p = candidates[0]
      const label = p.obligationId
        ? (obligationNames.get(p.obligationId) ?? p.payee ?? 'Scheduled bill')
        : p.payee || 'One-off payment'

      if (cents(p.amount) === cents(bankAmt)) {
        claimedPayments.add(p.id)
        autoClear.push({
          paymentId: p.id,
          transactionId: t.id,
          checkNumber: num,
          amount: bankAmt,
          postedDate,
          label,
        })
      } else {
        review.push({
          transactionId: t.id,
          checkNumber: num,
          bankAmount: bankAmt,
          postedDate,
          description,
          reason: 'amount_mismatch',
          paymentId: p.id,
          recordedAmount: p.amount,
          explanation: `Check #${num} cleared for ${money(bankAmt)}, but ${label} was recorded as ${money(p.amount)}. Confirm which is right.`,
          candidateObligationIds: p.obligationId ? [p.obligationId] : [],
        })
      }
      continue
    }

    // --- Tier 3: no payment row, but an open bill is for this exact amount ---
    const amtKey = cents(bankAmt)
    const sameAmount = unpaidWithoutPayment.filter((o) => cents(o.amount) === amtKey)

    if (sameAmount.length === 1 && (bankAmountCounts.get(amtKey) ?? 0) === 1) {
      const o = sameAmount[0]
      review.push({
        transactionId: t.id,
        checkNumber: num,
        bankAmount: bankAmt,
        postedDate,
        description,
        reason: 'possible_unrecorded_payment',
        explanation: `Check #${num} for ${money(bankAmt)} matches ${o.obligationName}, which is still marked unpaid. No payment was ever recorded for it.`,
        candidateObligationIds: [o.id],
      })
      continue
    }

    if (sameAmount.length > 0) {
      const why =
        (obligationAmountCounts.get(amtKey) ?? 0) > 1
          ? `${sameAmount.length} unpaid bills are for exactly ${money(bankAmt)}`
          : `more than one check in this period cleared for ${money(bankAmt)}`
      review.push({
        transactionId: t.id,
        checkNumber: num,
        bankAmount: bankAmt,
        postedDate,
        description,
        reason: 'ambiguous_amount',
        explanation: `Check #${num} for ${money(bankAmt)} could belong to more than one bill — ${why}. Pick the right one.`,
        candidateObligationIds: sameAmount.map((o) => o.id),
      })
      continue
    }

    // --- Tier 4: recent check that matches nothing on record ---
    if (dayDiff(postedDate, todayISO) <= opts.orphanReviewDays) {
      review.push({
        transactionId: t.id,
        checkNumber: num,
        bankAmount: bankAmt,
        postedDate,
        description,
        reason: 'unrecognized_check',
        explanation: `Check #${num} for ${money(bankAmt)} cleared on ${postedDate}, but no bill on record matches it. Link it to a bill or leave it as untracked spending.`,
        candidateObligationIds: [],
      })
    }
  }

  return {
    autoClear: autoClear.sort((a, b) => b.postedDate.localeCompare(a.postedDate)),
    review: review.sort((a, b) => b.postedDate.localeCompare(a.postedDate)),
  }
}

/** One-line summary for the sync log and the toast. */
export function describeAutoClearResult(r: AutoClearResult): string {
  const a = r.autoClear.length
  const v = r.review.length
  if (a === 0 && v === 0) return 'No bank checks needed matching.'
  const parts: string[] = []
  if (a > 0) parts.push(`${a} bill${a === 1 ? '' : 's'} matched and cleared automatically`)
  if (v > 0) parts.push(`${v} need${v === 1 ? 's' : ''} your review`)
  return parts.join(', ') + '.'
}
