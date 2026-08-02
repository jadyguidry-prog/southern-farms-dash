'use server'

// Writes for Bill Payments (Phase 1: check + ACH).
//
// Invariants, mirroring check-resolution:
//  - Payments live in `obligation_payments`. Source `financial_transactions` rows
//    are NEVER written; a Plaid clear only stamps the payment with the id of the
//    bank row it matched.
//  - Every state change is recorded in `obligation_payment_audit` so a void is
//    reversible and auditable.
//  - Recurring obligations ROLL FORWARD on payment (owner-approved default) rather
//    than being marked Paid, so a monthly bill never vanishes from the forecast.

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { addInterval } from '@/lib/health'

type ActionResult = { ok: boolean; error?: string; paymentId?: string }

/** Every surface that reads the cash summary or the obligations must refresh. */
const AFFECTED_PATHS = [
  '/bill-pay',
  '/cash-debt',
  '/cash-flow',
  '/marketing',
  '/',
  '/ai-advisor',
  '/reporting',
]
function revalidateAll() {
  for (const p of AFFECTED_PATHS) revalidatePath(p)
}

async function currentActor(): Promise<string | null> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  return data.user?.email ?? null
}

export type RecordPaymentInput = {
  obligationId: string
  amount: number
  paymentDate: string
  paymentMethod: 'check' | 'ach'
  checkNumber?: string
  bankAccountId?: string | null
  memo?: string
  /**
   * Advance a recurring obligation's next due date instead of leaving it. The UI
   * defaults this on for recurring bills; a one-time bill passes false.
   */
  rollForward?: boolean
}

/**
 * Record a payment against an obligation.
 *
 * ACH is written straight to 'cleared' (no float). A check starts 'outstanding'
 * and reduces spendable cash until it is seen clearing the bank.
 */
export async function recordPayment(input: RecordPaymentInput): Promise<ActionResult> {
  const obligationId = (input.obligationId ?? '').trim()
  const amount = Number(input.amount)
  const method = input.paymentMethod

  // Validate before any write — a payment with no amount or date is not a payment.
  if (!obligationId) return { ok: false, error: 'No obligation was selected.' }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter a payment amount greater than zero.' }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate ?? '')) {
    return { ok: false, error: 'Choose a valid payment date.' }
  }
  if (method !== 'check' && method !== 'ach') {
    return { ok: false, error: 'Choose check or ACH.' }
  }
  // A check without a number can't be matched to the bank later — require it, the
  // same way check-resolution refuses a blank payee.
  if (method === 'check' && !(input.checkNumber ?? '').trim()) {
    return { ok: false, error: 'Enter the check number.' }
  }

  const supabase = await createClient()
  const actor = await currentActor()
  const now = new Date().toISOString()

  // Confirm the obligation is real before writing a payment that references it.
  const { data: obligation, error: obErr } = await supabase
    .from('cash_obligations')
    .select('id, obligation_name, recurring, frequency, next_due_date, due_date')
    .eq('id', obligationId)
    .maybeSingle()
  if (obErr) return { ok: false, error: obErr.message }
  if (!obligation) {
    return { ok: false, error: 'That obligation no longer exists. Refresh and try again.' }
  }

  const isCleared = method === 'ach'
  const { data: inserted, error: insErr } = await supabase
    .from('obligation_payments')
    .insert({
      obligation_id: obligationId,
      amount,
      payment_date: input.paymentDate,
      payment_method: method,
      check_number: method === 'check' ? (input.checkNumber ?? '').trim() : null,
      bank_account_id: input.bankAccountId || null,
      status: isCleared ? 'cleared' : 'outstanding',
      cleared_date: isCleared ? input.paymentDate : null,
      memo: (input.memo ?? '').trim() || null,
      created_by: actor,
    })
    .select('id')
    .single()
  if (insErr) return { ok: false, error: insErr.message }

  await supabase.from('obligation_payment_audit').insert({
    payment_id: inserted.id,
    action: 'created',
    detail: {
      method,
      amount,
      status: isCleared ? 'cleared' : 'outstanding',
      obligation: obligation.obligation_name,
    },
    created_by: actor,
  })

  // Roll a recurring obligation forward so it stays in the forecast at its next
  // due date. `resolveNextDueDate` (used by the cash summary) intentionally
  // returns nextDueDate UNCHANGED when set and only advances up to today, so it
  // cannot express "advance PAST the period just paid". So advance explicitly
  // with the shared `addInterval` — one interval beyond the period that was paid.
  if (input.rollForward && obligation.recurring) {
    const current = obligation.next_due_date || obligation.due_date || input.paymentDate
    const nextDue = addInterval(
      new Date(current + 'T00:00:00'),
      obligation.frequency || 'Monthly',
    )
      .toISOString()
      .slice(0, 10)
    if (nextDue) {
      const { error: rollErr } = await supabase
        .from('cash_obligations')
        .update({ next_due_date: nextDue })
        .eq('id', obligationId)
      if (rollErr) {
        // The payment already succeeded; a roll-forward failure is non-fatal but
        // the owner should know the due date wasn't advanced.
        revalidateAll()
        return {
          ok: true,
          paymentId: inserted.id,
          error: `Payment saved, but the next due date wasn't advanced: ${rollErr.message}`,
        }
      }
    }
  }

  revalidateAll()
  return { ok: true, paymentId: inserted.id }
}

/**
 * Confirm a suggested Plaid/bank match: clear an outstanding check AND stamp the
 * bank row that cleared it. Separate from clearPayment because this records the
 * evidence (cleared_transaction_id) and is only ever reached by explicit owner
 * confirmation of a suggestion — never automatically.
 */
export async function confirmClearWithMatch(
  paymentId: string,
  transactionId: string,
): Promise<ActionResult> {
  if (!paymentId || !transactionId) {
    return { ok: false, error: 'A payment and a matching transaction are both required.' }
  }

  const supabase = await createClient()
  const actor = await currentActor()

  const { data: existing, error: readErr } = await supabase
    .from('obligation_payments')
    .select('id, status')
    .eq('id', paymentId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!existing) return { ok: false, error: 'That payment no longer exists.' }
  if (existing.status !== 'outstanding') {
    return { ok: false, error: 'Only an outstanding check can be cleared.' }
  }

  // Confirm the bank row is real and read its date, so cleared_date reflects when
  // it actually hit the account, not when the owner clicked confirm.
  const { data: txn, error: txnErr } = await supabase
    .from('financial_transactions')
    .select('id, transaction_date')
    .eq('id', transactionId)
    .is('deleted_at', null)
    .maybeSingle()
  if (txnErr) return { ok: false, error: txnErr.message }
  if (!txn) {
    return { ok: false, error: 'That bank transaction no longer exists. Refresh the matches.' }
  }

  const clearedDate = (txn.transaction_date ?? '').slice(0, 10) || null
  const { error: updErr } = await supabase
    .from('obligation_payments')
    .update({
      status: 'cleared',
      cleared_date: clearedDate,
      cleared_transaction_id: transactionId,
    })
    .eq('id', paymentId)
    // Only clear a still-outstanding row, so two confirmations racing can't both win.
    .eq('status', 'outstanding')
  if (updErr) {
    // The unique index on cleared_transaction_id turns a double-match into an
    // error rather than a silent double-clear — translate it for the owner.
    if (updErr.code === '23505') {
      return {
        ok: false,
        error: 'That bank transaction was already used to clear another check.',
      }
    }
    return { ok: false, error: updErr.message }
  }

  await supabase.from('obligation_payment_audit').insert({
    payment_id: paymentId,
    action: 'cleared',
    detail: { clearedDate, source: 'bank_match', transactionId },
    created_by: actor,
  })

  revalidateAll()
  return { ok: true, paymentId }
}

/**
 * Void a payment. Soft state change, not a delete: the audit row keeps the record
 * that a check was written and then voided (e.g. lost in the mail, reissued).
 */
export async function voidPayment(paymentId: string, reason?: string): Promise<ActionResult> {
  if (!paymentId) return { ok: false, error: 'No payment was specified.' }

  const supabase = await createClient()
  const actor = await currentActor()

  const { data: existing, error: readErr } = await supabase
    .from('obligation_payments')
    .select('id, status')
    .eq('id', paymentId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!existing) return { ok: false, error: 'That payment no longer exists.' }
  if (existing.status === 'void') return { ok: false, error: 'That payment is already void.' }

  const { error: updErr } = await supabase
    .from('obligation_payments')
    .update({ status: 'void' })
    .eq('id', paymentId)
  if (updErr) return { ok: false, error: updErr.message }

  await supabase.from('obligation_payment_audit').insert({
    payment_id: paymentId,
    action: 'voided',
    detail: { previousStatus: existing.status, reason: (reason ?? '').trim() || null },
    created_by: actor,
  })

  revalidateAll()
  return { ok: true, paymentId }
}

/**
 * Manually clear an outstanding check (owner saw it on the statement) without a
 * matched Plaid row. Suggested Plaid matches use a separate confirm path.
 */
export async function clearPayment(
  paymentId: string,
  clearedDate: string,
): Promise<ActionResult> {
  if (!paymentId) return { ok: false, error: 'No payment was specified.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clearedDate ?? '')) {
    return { ok: false, error: 'Choose the date the check cleared.' }
  }

  const supabase = await createClient()
  const actor = await currentActor()

  const { data: existing, error: readErr } = await supabase
    .from('obligation_payments')
    .select('id, status')
    .eq('id', paymentId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!existing) return { ok: false, error: 'That payment no longer exists.' }
  if (existing.status !== 'outstanding') {
    return { ok: false, error: 'Only an outstanding check can be cleared.' }
  }

  const { error: updErr } = await supabase
    .from('obligation_payments')
    .update({ status: 'cleared', cleared_date: clearedDate })
    .eq('id', paymentId)
  if (updErr) return { ok: false, error: updErr.message }

  await supabase.from('obligation_payment_audit').insert({
    payment_id: paymentId,
    action: 'cleared',
    detail: { clearedDate, source: 'manual' },
    created_by: actor,
  })

  revalidateAll()
  return { ok: true, paymentId }
}
