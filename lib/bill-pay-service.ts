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
import { fetchAllPages } from '@/lib/paginate'

export type PaymentMethod = 'check' | 'ach'
export type PaymentStatus = 'outstanding' | 'cleared' | 'void'

export type ObligationPayment = {
  id: string
  obligationId: string
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
}

type PaymentRow = {
  id: string
  obligation_id: string
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
  }
}

/**
 * Every non-void payment, newest first. Void payments are excluded because a
 * voided check never left the account — including it would double-count against
 * the obligation and inflate the outstanding total.
 */
export async function getObligationPayments(): Promise<ObligationPayment[]> {
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
}

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
