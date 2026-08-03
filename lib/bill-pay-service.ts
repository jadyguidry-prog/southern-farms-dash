// Server-side loader for Bill Payments (Phase 1: check + ACH) and the
// outstanding-check cash math that the shared cash summary depends on.
//
// Central rule, mirroring check-resolution: payments are an OVERLAY stored in
// `obligation_payments`. A payment NEVER mutates the source `cash_obligations`
// row. Rolling a recurring bill forward is a deliberate, audited write in
// `app/bill-pay/actions.ts` against the obligation's own next_due_date column;
// this file only reads.
//
// The one fact this module exists to produce for the rest of the app:
//   outstanding checks = money already promised (a check is written) but not yet
//   gone from the bank. Bank balances still include it, so spendable cash is
//   LOWER than the balance shows. ACH is treated as gone immediately (no float).

import { createClient } from '@/lib/supabase/server'
import { cache } from 'react'
import { fetchAllPages } from '@/lib/paginate'
import { addInterval } from '@/lib/health'
import {
  buildAchReconcileMatches,
  descriptionMatchesVendor,
  ACH_LOOKBACK_DAYS,
  type AchObligationInput,
  type AchReconcileMatch,
} from '@/lib/bill-pay-shared'

export type PaymentMethod = 'check' | 'ach'
export type PaymentStatus = 'outstanding' | 'cleared' | 'void'

export type ObligationPayment = {
  id: string
  /**
   * Null for a one-off check (a payment with no recurring bill behind it — a
   * seed supplier, a repair). Such a payment identifies itself via payeeName
   * instead; a DB check constraint guarantees one of the two is always present,
   * so a payment can never be anonymous.
   */
  obligationId: string | null
  amount: number
  paymentDate: string
  paymentMethod: PaymentMethod
  checkNumber: string | null
  bankAccountId: string | null
  status: PaymentStatus
  clearedDate: string | null
  clearedTransactionId: string | null
  memo: string
  createdAt: string
  /** Who the one-off check was written to. Empty for obligation-backed payments. */
  payeeName: string
  /** Set when the payee was picked from the known vendor list rather than typed. */
  payeeVendorId: string | null
  /** What a one-off check was for, so the ledger stays self-explanatory. */
  purpose: string
}

type PaymentRow = {
  id: string
  obligation_id: string | null
  amount: number | string | null
  payment_date: string | null
  payment_method: string | null
  check_number: string | null
  bank_account_id: string | null
  status: string | null
  cleared_date: string | null
  cleared_transaction_id: string | null
  memo: string | null
  created_at: string | null
  payee_name?: string | null
  payee_vendor_id?: string | null
  purpose?: string | null
}

function mapPayment(r: PaymentRow): ObligationPayment {
  return {
    id: r.id,
    obligationId: r.obligation_id,
    amount: Number(r.amount) || 0,
    paymentDate: (r.payment_date ?? '').slice(0, 10),
    // Constrained by a DB check; the fallback keeps a bad row from crashing a render.
    paymentMethod: r.payment_method === 'ach' ? 'ach' : 'check',
    checkNumber: r.check_number,
    bankAccountId: r.bank_account_id,
    status:
      r.status === 'cleared' ? 'cleared' : r.status === 'void' ? 'void' : 'outstanding',
    clearedDate: r.cleared_date ? r.cleared_date.slice(0, 10) : null,
    clearedTransactionId: r.cleared_transaction_id,
    memo: r.memo ?? '',
    createdAt: r.created_at ?? '',
    payeeName: r.payee_name ?? '',
    payeeVendorId: r.payee_vendor_id ?? null,
    purpose: r.purpose ?? '',
  }
}

/**
 * Every non-void payment, newest first. Void payments are excluded because a
 * voided check never left the account — including it would double-count against
 * the obligation and inflate the outstanding total.
 *
 * Wrapped in React `cache` (the same pattern as getCashDebtSummary and
 * getLaborDataset) so the several callers that each need the payment list — the
 * cash summary, the dashboard snapshot, and the match suggestions — share ONE
 * query per request instead of refetching the table for each.
 */
export const getObligationPayments = cache(async (): Promise<ObligationPayment[]> => {
  const supabase = await createClient()
  const rows = await fetchAllPages<PaymentRow>(
    (from, to) =>
      supabase
        .from('obligation_payments')
        .select('*')
        .neq('status', 'void')
        .order('created_at', { ascending: false })
        .range(from, to),
    'getObligationPayments',
  )
  return rows.map(mapPayment)
})

/**
 * The outstanding-check total: written checks not yet seen clearing the bank.
 *
 * This is the single number the cash summary subtracts from cashOnHand. ACH is
 * never outstanding (it is written as cleared), so this is checks only, by
 * construction of the status field rather than by filtering on method — a future
 * method that also floats (e.g. mailed money order) would be counted correctly
 * without touching this code.
 */
export function sumOutstanding(payments: ObligationPayment[]): number {
  return payments
    .filter((p) => p.status === 'outstanding')
    .reduce((s, p) => s + p.amount, 0)
}

/**
 * Cash math the whole app shares. Kept pure so it can be unit-tested without a
 * database and so Dashboard / Cash Flow / Marketing cannot derive it differently.
 *
 * `cashAvailable` is cash the owner can actually spend today: the bank balance
 * minus checks that are still going to hit it. Never negative-clamped — a
 * negative value is real information (more checks are out than there is cash) and
 * hiding it would be the opposite of the point.
 */
export function deriveOutstandingCash(cashOnHand: number, payments: ObligationPayment[]) {
  const outstandingChecks = sumOutstanding(payments)
  return {
    outstandingChecks,
    outstandingCheckCount: payments.filter((p) => p.status === 'outstanding').length,
    // The spendable figure. Named distinctly from cashOnHand so nothing downstream
    // silently swaps one for the other.
    cashAvailable: cashOnHand - outstandingChecks,
  }
}

/**
 * Read the outstanding figures directly (for callers that already have or don't
 * need the full payment list). Degrades to zeroes if the table is unreadable, so
 * a bill-pay problem can never blank out the cash dashboard.
 */
export async function getOutstandingCheckSummary(cashOnHand: number) {
  try {
    const payments = await getObligationPayments()
    return deriveOutstandingCash(cashOnHand, payments)
  } catch (err) {
    console.log('[v0] getOutstandingCheckSummary failed, degrading to zero:', err)
    return { outstandingChecks: 0, outstandingCheckCount: 0, cashAvailable: cashOnHand }
  }
}

/**
 * The next due date for a recurring obligation after the current period is paid.
 *
 * Deliberately NOT `resolveNextDueDate` from lib/health: that helper returns an
 * existing nextDueDate unchanged and only advances up to today, so it cannot
 * express "advance past the period just paid" — and paying a bill early would
 * leave the obligation sitting on a date already settled.
 */
export function nextDueAfterPayment(currentDue: string, frequency: string): string {
  return addInterval(new Date(currentDue + 'T00:00:00'), frequency || 'Monthly')
    .toISOString()
    .slice(0, 10)
}

export type ClearingSuggestion = {
  paymentId: string
  transactionId: string
  /**
   * 'check_number' is a near-certain match; 'amount_date' is a heuristic to confirm.
   * 'vendor_amount' pairs a pending ACH draft (a logged Sysco/Quirch invoice) to its
   * bank debit by payee name + amount — there is no check number on an ACH.
   */
  matchType: 'check_number' | 'amount_date' | 'vendor_amount'
  checkNumber: string | null
  /** Who the payment was to, so a numberless ACH draft is still identifiable on screen. */
  payeeName: string
  amount: number
  paymentDate: string
  transactionDate: string
  transactionDescription: string
}

export type TxnRow = {
  id: string
  transaction_date: string | null
  amount: number | string | null
  description: string | null
  check_number: string | null
  account_name: string | null
  transaction_type: string | null
}

/**
 * Suggest which outstanding checks appear to have cleared the bank, WITHOUT
 * writing anything. The owner confirms each on screen (see confirmClearWithMatch)
 * — Plaid data is never trusted to silently resolve a payment, the same rule
 * check-resolution follows.
 *
 * Matching, strongest first:
 *  1. check_number equal — banks record the check number on cleared checks, so
 *     this is all but certain. 196 of the CSV expense rows already carry one.
 *  2. exact amount AND the bank date is on/after the check was written, within a
 *     reasonable clearing window — a heuristic, flagged as such to the owner.
 *
 * Direction matters: amounts are stored POSITIVE with direction in
 * transaction_type, so only outgoing types (expense/payment) can clear a check.
 * A transaction already used to clear another payment is excluded so one bank row
 * can never resolve two checks (the DB unique index is the backstop).
 */
export async function getClearingSuggestions(): Promise<ClearingSuggestion[]> {
  const supabase = await createClient()

  let payments: ObligationPayment[]
  try {
    payments = await getObligationPayments()
  } catch (err) {
    console.log('[v0] getClearingSuggestions: payments unreadable:', err)
    return []
  }
  // Outstanding checks, plus pending ACH drafts (a logged COGS invoice whose draft
  // hasn't pulled yet). A pending ACH is identified by its payee, since there is no
  // check number to key on — without a payee it could never be matched, so it is
  // excluded rather than left to match on amount alone.
  const outstanding = payments.filter(
    (p) =>
      p.status === 'outstanding' &&
      (p.paymentMethod === 'check' || (p.paymentMethod === 'ach' && p.payeeName.trim() !== '')),
  )
  if (outstanding.length === 0) return []

  // Transaction ids already consumed by a cleared payment — never re-suggest them.
  const usedTxnIds = new Set(
    payments.map((p) => p.clearedTransactionId).filter((x): x is string => Boolean(x)),
  )

  // Only outgoing bank rows can clear a check. Bounded to a sensible window before
  // the earliest outstanding check so we don't scan the whole ledger.
  // Start the scan before the earliest expected date: unlike a check, an ACH draft
  // can pull EARLIER than the date the owner expected, and a row outside this window
  // could never be suggested.
  const earliestExpected = outstanding.map((p) => p.paymentDate).filter(Boolean).sort()[0]
  const earliest = earliestExpected
    ? new Date(
        new Date(earliestExpected + 'T00:00:00').getTime() -
          ACH_DRAFT_WINDOW_DAYS * 86_400_000,
      )
        .toISOString()
        .slice(0, 10)
    : undefined
  let txns: TxnRow[] = []
  try {
    txns = await fetchAllPages<TxnRow>(
      (from, to) =>
        supabase
          .from('financial_transactions')
          .select(
            'id, transaction_date, amount, description, check_number, account_name, transaction_type',
          )
          .is('deleted_at', null)
          .in('transaction_type', ['expense', 'payment'])
          .gte('transaction_date', earliest || '1900-01-01')
          .order('transaction_date', { ascending: true })
          .range(from, to),
      'getClearingSuggestions',
    )
  } catch (err) {
    console.log('[v0] getClearingSuggestions: transactions unreadable:', err)
    return []
  }
  const candidates = txns.filter((t) => !usedTxnIds.has(t.id))

  return buildClearingSuggestions(outstanding, candidates)
}

/**
 * Detect autopay/ACH bills that a bank debit has already paid, WITHOUT writing.
 * The page shows these for a one-tap reconcile; the write happens in the action
 * (which re-runs this so it never trusts client-supplied matches). Read-only, and
 * degrades to [] on any failure so a feed hiccup can never blank the page.
 */
export async function getAchReconcileMatches(): Promise<AchReconcileMatch[]> {
  const supabase = await createClient()
  const today = new Date().toISOString().slice(0, 10)
  const since = new Date(Date.now() - ACH_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)

  let obligations: AchObligationInput[]
  try {
    const { data } = await supabase
      .from('cash_obligations')
      .select(
        'id, obligation_name, vendor_name, amount, frequency, next_due_date, recurring, active, payment_method',
      )
    obligations = (data ?? []).map((o) => ({
      id: o.id,
      obligationName: o.obligation_name ?? '',
      vendorName: o.vendor_name ?? '',
      amount: Number(o.amount) || 0,
      frequency: o.frequency ?? 'Monthly',
      nextDueDate: o.next_due_date ?? '',
      recurring: Boolean(o.recurring),
      active: o.active ?? true,
      paymentMethod: o.payment_method ?? '',
    }))
  } catch (err) {
    console.log('[v0] getAchReconcileMatches: obligations unreadable:', err)
    return []
  }
  // No ACH obligations -> nothing to detect, skip the transaction scan entirely.
  if (!obligations.some((o) => o.paymentMethod.toUpperCase() === 'ACH')) return []

  let linked: string[]
  try {
    const payments = await getObligationPayments()
    linked = payments
      .map((p) => p.clearedTransactionId)
      .filter((x): x is string => Boolean(x))
  } catch (err) {
    console.log('[v0] getAchReconcileMatches: payments unreadable:', err)
    return []
  }

  let txns: TxnRow[] = []
  try {
    txns = await fetchAllPages<TxnRow>(
      (from, to) =>
        supabase
          .from('financial_transactions')
          .select(
            'id, transaction_date, amount, description, check_number, account_name, transaction_type',
          )
          .is('deleted_at', null)
          .in('transaction_type', ['expense', 'payment'])
          .gte('transaction_date', since)
          .order('transaction_date', { ascending: false })
          .range(from, to),
      'getAchReconcileMatches',
    )
  } catch (err) {
    console.log('[v0] getAchReconcileMatches: transactions unreadable:', err)
    return []
  }

  return buildAchReconcileMatches(obligations, txns, linked, today)
}

/** Longest plausible clearing window for a mailed check. */
export const CLEAR_WINDOW_DAYS = 45

/**
 * How far an ACH draft may land from the date the owner expected, in EITHER
 * direction. Kept well under a month so a logged weekly COGS invoice cannot reach
 * across to a different month's draft, while still absorbing a bank pulling a few
 * days early or late.
 */
export const ACH_DRAFT_WINDOW_DAYS = 10

/**
 * The pure matching algorithm behind getClearingSuggestions, split out so the
 * rules can be regression-tested without a database. Given outstanding checks
 * and candidate outgoing bank rows, decide which pairs to SUGGEST.
 *
 * Ordering matters and is deliberate: check-number matches run first so a
 * coincidental same-amount row cannot steal a transaction that a numbered match
 * wants. Each transaction can be claimed only once per pass, so one bank row
 * never resolves two different checks.
 */
export function buildClearingSuggestions(
  payments: ObligationPayment[],
  candidates: TxnRow[],
): ClearingSuggestion[] {
  const suggestions: ClearingSuggestion[] = []
  const claimed = new Set<string>()

  // Defence in depth: only an unsettled payment can be suggested for clearing.
  // Callers already filter, but re-suggesting an already-cleared payment would
  // double-count it against cash, so the rule is enforced here where it cannot be
  // bypassed rather than trusted to every future caller.
  const outstanding = payments.filter((p) => p.status === 'outstanding')

  const build = (
    p: ObligationPayment,
    hit: TxnRow,
    matchType: ClearingSuggestion['matchType'],
  ): ClearingSuggestion => ({
    paymentId: p.id,
    transactionId: hit.id,
    matchType,
    checkNumber: p.checkNumber,
    payeeName: p.payeeName,
    amount: p.amount,
    paymentDate: p.paymentDate,
    transactionDate: (hit.transaction_date ?? '').slice(0, 10),
    transactionDescription: hit.description ?? '',
  })

  // Pass 1: exact check-number match (strongest evidence).
  for (const p of outstanding) {
    if (!p.checkNumber) continue
    const hit = candidates.find(
      (t) =>
        !claimed.has(t.id) &&
        t.check_number &&
        t.check_number.trim() === p.checkNumber!.trim(),
    )
    if (hit) {
      claimed.add(hit.id)
      suggestions.push(build(p, hit, 'check_number'))
    }
  }

  // Pass 2: amount + date-window heuristic for checks still unmatched. Restricted to
  // checks deliberately — a numberless ACH matched on amount alone is exactly the
  // false positive that would clear the wrong weekly COGS draft.
  const matchedPaymentIds = new Set(suggestions.map((s) => s.paymentId))
  for (const p of outstanding) {
    if (p.paymentMethod !== 'check') continue
    if (matchedPaymentIds.has(p.id)) continue
    const hit = candidates.find((t) => {
      if (claimed.has(t.id)) return false
      // Tolerance guards float noise without letting a different amount match.
      if (Math.abs((Number(t.amount) || 0) - p.amount) > 0.005) return false
      const td = (t.transaction_date ?? '').slice(0, 10)
      // A check cannot clear before it was written.
      if (!td || td < p.paymentDate) return false
      const days =
        (new Date(td + 'T00:00:00').getTime() -
          new Date(p.paymentDate + 'T00:00:00').getTime()) /
        86_400_000
      return days <= CLEAR_WINDOW_DAYS
    })
    if (hit) {
      claimed.add(hit.id)
      suggestions.push(build(p, hit, 'amount_date'))
    }
  }

  // Pass 3: pending ACH drafts (logged COGS invoices) matched by PAYEE NAME in the
  // bank description plus amount — an ACH carries no check number, so the vendor name
  // is the identifier, exactly as in the autopay reconcile.
  //
  // Two tiers with exact amount first: when several weekly drafts to the same vendor
  // are in flight, the unambiguous pair must win the transaction before a
  // near-amount guess can take it.
  //
  // The date window is TWO-SIDED, unlike a check: the owner records an *expected*
  // draft date and the bank may pull a few days early or late, so the
  // "cannot clear before it was written" rule of pass 2 does not apply here.
  const achPending = outstanding.filter(
    (p) => p.paymentMethod === 'ach' && p.payeeName.trim() !== '',
  )
  for (const tier of ['exact', 'near'] as const) {
    for (const p of achPending) {
      if (suggestions.some((s) => s.paymentId === p.id)) continue
      const hit = candidates.find((t) => {
        if (claimed.has(t.id)) return false
        if (!descriptionMatchesVendor(p.payeeName, t.description ?? '')) return false
        const diff = Math.abs((Number(t.amount) || 0) - p.amount)
        // 'near' stays tight (2% / $25): a loose band could pair one week's invoice
        // with the neighbouring week's draft, which sit only days apart.
        if (tier === 'exact' ? diff > 0.005 : diff > Math.max(p.amount * 0.02, 25)) {
          return false
        }
        const td = (t.transaction_date ?? '').slice(0, 10)
        if (!td) return false
        const days = Math.abs(
          (new Date(td + 'T00:00:00').getTime() -
            new Date(p.paymentDate + 'T00:00:00').getTime()) / 86_400_000,
        )
        return days <= ACH_DRAFT_WINDOW_DAYS
      })
      if (hit) {
        claimed.add(hit.id)
        suggestions.push(build(p, hit, 'vendor_amount'))
      }
    }
  }

  return suggestions
}

export type BillPaySnapshot = {
  configured: boolean
  outstandingChecks: number
  outstandingCheckCount: number
  // Oldest outstanding check in days — a stale uncashed check is worth chasing.
  oldestOutstandingDays: number | null
  paymentsThisMonth: number
  paymentsThisMonthAmount: number
}

/**
 * Compact snapshot for the Dashboard tile, the AI Advisor signal set, and the
 * Reporting page — the three surfaces every module must feed. Read-only.
 */
export async function getBillPaySnapshot(): Promise<BillPaySnapshot> {
  let payments: ObligationPayment[]
  try {
    payments = await getObligationPayments()
  } catch (err) {
    console.log('[v0] getBillPaySnapshot failed, degrading:', err)
    return {
      configured: false,
      outstandingChecks: 0,
      outstandingCheckCount: 0,
      oldestOutstandingDays: null,
      paymentsThisMonth: 0,
      paymentsThisMonthAmount: 0,
    }
  }

  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const monthPrefix = todayStr.slice(0, 7)

  const outstanding = payments.filter((p) => p.status === 'outstanding')
  const oldest = outstanding
    .map((p) => p.paymentDate)
    .filter(Boolean)
    .sort()[0]
  const oldestOutstandingDays = oldest
    ? Math.max(
        0,
        Math.floor(
          (today.getTime() - new Date(oldest + 'T00:00:00').getTime()) / 86_400_000,
        ),
      )
    : null

  const thisMonth = payments.filter((p) => p.paymentDate.startsWith(monthPrefix))

  return {
    configured: payments.length > 0,
    outstandingChecks: outstanding.reduce((s, p) => s + p.amount, 0),
    outstandingCheckCount: outstanding.length,
    oldestOutstandingDays,
    paymentsThisMonth: thisMonth.length,
    paymentsThisMonthAmount: thisMonth.reduce((s, p) => s + p.amount, 0),
  }
}
