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
import { nextDueAfterPayment, getAchReconcileMatches } from '@/lib/bill-pay-service'
import { validatePaymentBasics } from '@/lib/bill-pay-shared'

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
  const invalid = validatePaymentBasics(input)
  if (invalid) return { ok: false, error: invalid }

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
  // due date, using the shared pure helper (regression-tested in
  // scripts/verify-bill-pay.ts) rather than duplicating the date math here.
  if (input.rollForward && obligation.recurring) {
    const current = obligation.next_due_date || obligation.due_date || input.paymentDate
    const nextDue = nextDueAfterPayment(current, obligation.frequency || 'Monthly')
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

export type ReconcileResult = {
  ok: boolean
  error?: string
  count: number
  lines: string[]
}

/**
 * Auto-reconcile autopay/ACH bills against the checking feed: for each bank debit
 * the matcher identifies (by vendor name + amount), write a CLEARED payment dated
 * on the ACTUAL posted date and advance the bill's schedule past it.
 *
 * Re-runs detection server-side rather than trusting anything from the client, so
 * a stale or forged match can't create a bogus payment. Idempotent: the DB unique
 * index on cleared_transaction_id means a transaction already linked to a payment
 * is skipped (23505) instead of double-counted, so tapping twice is harmless.
 *
 * Every payment it writes is an ordinary row — the owner can void any one in a tap
 * if a match was ever wrong. That reversibility is why one-tap auto-write is safe.
 */
export async function reconcileAchFromBank(): Promise<ReconcileResult> {
  const matches = await getAchReconcileMatches()
  if (matches.length === 0) return { ok: true, count: 0, lines: [] }

  const supabase = await createClient()
  const actor = await currentActor()

  // Load the schedule fields once for roll-forward; keyed by obligation id.
  const obligationIds = [...new Set(matches.map((m) => m.obligationId))]
  const { data: obligationRows, error: obErr } = await supabase
    .from('cash_obligations')
    .select('id, next_due_date, due_date, frequency')
    .in('id', obligationIds)
  if (obErr) return { ok: false, error: obErr.message, count: 0, lines: [] }
  const obligationById = new Map((obligationRows ?? []).map((o) => [o.id, o]))

  const lines: string[] = []
  let count = 0
  // Track the latest reconciled date per obligation, to advance the schedule once.
  const latestPosted = new Map<string, string>()

  for (const m of matches) {
    const { data: inserted, error: insErr } = await supabase
      .from('obligation_payments')
      .insert({
        obligation_id: m.obligationId,
        amount: m.amount,
        payment_date: m.postedDate,
        payment_method: 'ach',
        status: 'cleared',
        cleared_date: m.postedDate,
        cleared_transaction_id: m.transactionId,
        memo: null,
        created_by: actor,
      })
      .select('id')
      .single()

    if (insErr) {
      // 23505 = unique violation: this bank row was already linked (a concurrent
      // reconcile or manual clear). That's the guard working — skip, don't fail.
      if ((insErr as { code?: string }).code === '23505') continue
      return { ok: false, error: insErr.message, count, lines }
    }

    await supabase.from('obligation_payment_audit').insert({
      payment_id: inserted.id,
      action: 'created',
      detail: {
        method: 'ach',
        amount: m.amount,
        status: 'cleared',
        obligation: m.obligationName,
        // Marks this as a machine match from the bank, distinct from a hand entry.
        source: 'bank_auto',
        transaction_id: m.transactionId,
        posted_date: m.postedDate,
      },
      created_by: actor,
    })

    count++
    lines.push(`${m.obligationName} — ${m.postedDate}`)
    const prev = latestPosted.get(m.obligationId)
    if (!prev || m.postedDate > prev) latestPosted.set(m.obligationId, m.postedDate)
  }

  // Advance each bill's next due date past the newest debit we just reconciled —
  // but only forward. Backfilled past periods (next_due already in the future)
  // leave the schedule untouched, which is correct: the next unpaid period is
  // still ahead. Non-fatal if it fails; the payments are already saved.
  for (const [obligationId, posted] of latestPosted) {
    const ob = obligationById.get(obligationId)
    if (!ob) continue
    let due = ob.next_due_date || ob.due_date || ''
    if (!due) continue
    let advanced = false
    // Guard the loop against a bad frequency that never advances the date.
    for (let i = 0; i < 240 && due <= posted; i++) {
      const next = nextDueAfterPayment(due, ob.frequency || 'Monthly')
      if (!next || next <= due) break
      due = next
      advanced = true
    }
    if (advanced) {
      await supabase
        .from('cash_obligations')
        .update({ next_due_date: due })
        .eq('id', obligationId)
    }
  }

  revalidateAll()
  return { ok: true, count, lines }
}

export type RecordOneOffInput = {
  /** Free-typed payee, or the name of the picked vendor. Always required. */
  payeeName: string
  /** Set when the payee came from the known vendor list, for future reporting. */
  payeeVendorId?: string | null
  amount: number
  paymentDate: string
  paymentMethod: 'check' | 'ach'
  checkNumber?: string
  bankAccountId?: string | null
  purpose?: string
  memo?: string
  /**
   * ACH only: the draft has NOT pulled yet (a logged COGS invoice awaiting its
   * weekly Sysco/Quirch draft). Records the payment as `outstanding` so it reduces
   * spendable cash during the float, instead of the default "ACH already happened".
   * `paymentDate` is then the EXPECTED draft date.
   */
  pending?: boolean
}

/**
 * Record a payment that has NO scheduled bill behind it — a seed supplier, an
 * equipment repair, a one-time contractor.
 *
 * This exists because most checks the owner writes are not against the nine
 * recurring obligations, and without it those checks never reduce spendable cash,
 * which quietly makes the float number wrong in the optimistic direction.
 *
 * Deliberately separate from recordPayment rather than folded into it: there is no
 * obligation to verify and nothing to roll forward, so sharing one function would
 * mean a pile of conditional branches around every obligation step. The rules that
 * MUST agree (amount, date, method, check number) are shared via
 * validatePaymentBasics instead, so the two paths cannot drift.
 */
export async function recordOneOffPayment(
  input: RecordOneOffInput,
): Promise<ActionResult> {
  const payeeName = (input.payeeName ?? '').trim()
  const amount = Number(input.amount)
  const method = input.paymentMethod

  // A payment with no payee is unauditable — you cannot tell later who was paid,
  // and the DB check constraint would reject it anyway. Fail with a clear message
  // rather than surfacing a raw constraint violation.
  if (!payeeName) return { ok: false, error: 'Enter who the payment was made out to.' }
  const invalid = validatePaymentBasics(input)
  if (invalid) return { ok: false, error: invalid }

  const supabase = await createClient()
  const actor = await currentActor()

  // An ACH normally records something that already left the account, so it is
  // cleared on entry. A *pending* ACH is the opposite — a draft that will pull in a
  // few days — so it stays outstanding and floats, exactly like a written check.
  // `pending` is ignored for checks, which are never cleared on entry anyway.
  const isCleared = method === 'ach' && !input.pending
  const { data: inserted, error: insErr } = await supabase
    .from('obligation_payments')
    .insert({
      // Null obligation is what marks this as a one-off; the DB check constraint
      // requires payee_name to be present in exactly this case.
      obligation_id: null,
      payee_name: payeeName,
      payee_vendor_id: input.payeeVendorId || null,
      purpose: (input.purpose ?? '').trim() || null,
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
      payee: payeeName,
      purpose: (input.purpose ?? '').trim() || null,
      one_off: true,
      // Distinguishes a logged invoice awaiting its draft from a settled ACH.
      pending_draft: method === 'ach' && Boolean(input.pending),
    },
    created_by: actor,
  })

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
