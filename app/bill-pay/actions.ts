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
import { nextScheduledDueDate, getAchReconcileMatches } from '@/lib/bill-pay-service'
import {
  runAutoClear,
  getAutoClearCandidates,
} from '@/lib/obligation-auto-clear-service'
import {
  validatePaymentBasics,
  validateBillDueBasics,
  validatePaymentEdit,
  editBreaksReconciliation,
  resolveOneTimeBillStatus,
} from '@/lib/bill-pay-shared'

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
    // `amount` and `status` are needed to decide whether a ONE-TIME bill is now
    // fully covered and should close (see the closing block below).
    .select(
      'id, obligation_name, recurring, frequency, next_due_date, due_date, amount, status',
    )
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
  // due date. Derived from the schedule anchor + the full payment history (see
  // nextScheduledDueDate) rather than by incrementing the stored next_due_date —
  // the old approach skipped a whole period whenever that field had drifted ahead.
  if (input.rollForward && obligation.recurring) {
    // Latest non-void payment INCLUDING the one just inserted, so the schedule
    // lands on the first genuinely unpaid period no matter what next_due_date says.
    const { data: paidRows } = await supabase
      .from('obligation_payments')
      .select('payment_date')
      .eq('obligation_id', obligationId)
      .neq('status', 'void')
    const paidThrough =
      (paidRows ?? [])
        .map((p) => (p.payment_date ?? '').slice(0, 10))
        .filter(Boolean)
        .sort()
        .pop() ?? input.paymentDate
    const anchor = obligation.due_date || obligation.next_due_date || input.paymentDate
    const nextDue = nextScheduledDueDate(
      anchor,
      obligation.frequency || 'Monthly',
      paidThrough,
    )
    if (nextDue && nextDue !== obligation.next_due_date) {
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

  // A ONE-TIME bill has no next period to roll to, so it closes instead — but
  // only once its payments actually COVER it.
  //
  // The bug this fixes: recordPayment previously only ever advanced recurring
  // bills and never touched status. Bill Pay lists obligations where
  // `status !== 'Paid'`, so a one-time invoice stayed on the payable list forever
  // after being paid, counting the same money twice — once as still owed and
  // once as paid. It had never been hit because all 10 existing obligations are
  // recurring; it would have fired on the very first invoice entered.
  //
  // Summing NON-VOID payments (rather than closing on this single payment) is
  // what makes a partial payment safe: $400 against a $1,000 invoice leaves the
  // bill open with $600 still genuinely owed.
  if (!obligation.recurring) {
    const { data: paidRows, error: paidErr } = await supabase
      .from('obligation_payments')
      .select('amount')
      .eq('obligation_id', obligationId)
      .neq('status', 'void')
    if (!paidErr) {
      const paidTotal = (paidRows ?? []).reduce(
        (sum, r) => sum + (Number(r.amount) || 0),
        0,
      )
      const nextStatus = resolveOneTimeBillStatus(Number(obligation.amount), paidTotal)
      if (nextStatus !== obligation.status) {
        const { error: closeErr } = await supabase
          .from('cash_obligations')
          .update({ status: nextStatus })
          .eq('id', obligationId)
        if (closeErr) {
          // The payment itself succeeded, so this is reported rather than thrown —
          // but it must be reported, because a bill that failed to close keeps
          // inflating what the owner appears to owe.
          revalidateAll()
          return {
            ok: true,
            paymentId: inserted.id,
            error: `Payment saved, but the bill wasn't marked paid: ${closeErr.message}`,
          }
        }
      }
    }
  }

  revalidateAll()
  return { ok: true, paymentId: inserted.id }
}

/**
 * Save an invoice that is DUE but not yet paid.
 *
 * Writes the same `cash_obligations` row that Cash & Debt's obligation editor
 * writes, so a bill entered here is the identical kind of record — it appears in
 * the payable list, the 30-day cash forecast and the advisor without any
 * special-casing. Bill Pay only needed an entry point, not a parallel table.
 *
 * Always one-time (`recurring: false`): a recurring bill belongs in Cash & Debt
 * where the frequency and schedule anchor can be set properly, and the dialog
 * links there for that case.
 */
export type CreateBillDueInput = {
  obligationName: string
  vendorName?: string
  amount: number
  dueDate: string
  invoiceNumber?: string
  category?: string
  notes?: string
}

export async function createBillDue(
  input: CreateBillDueInput,
): Promise<{ ok: boolean; error?: string; obligationId?: string }> {
  const invalid = validateBillDueBasics(input)
  if (invalid) return { ok: false, error: invalid }

  const supabase = await createClient()
  const name = input.obligationName.trim()
  const invoiceNumber = (input.invoiceNumber ?? '').trim()

  // Empty optional text is stored as NULL, never '', so "not recorded" stays
  // distinguishable from a recorded blank.
  const { data, error } = await supabase
    .from('cash_obligations')
    .insert({
      obligation_name: name,
      vendor_name: (input.vendorName ?? '').trim() || null,
      amount: Number(input.amount),
      due_date: input.dueDate,
      // Seeded equal to due_date so the forecast has a date to work from; for a
      // one-time bill the two never diverge, since nothing rolls it forward.
      next_due_date: input.dueDate,
      recurring: false,
      frequency: 'One-time',
      status: 'Pending',
      active: true,
      // Paid by check unless the owner says otherwise. NOT 'ACH': an ACH bill is
      // auto-reconciled from the bank feed, so mislabelling a one-off invoice as
      // ACH would let the matcher close it against an unrelated debit.
      payment_method: 'Check',
      invoice_number: invoiceNumber || null,
      category: (input.category ?? '').trim() || null,
      // No created_by: cash_obligations has no such column (obligation_payments
      // does, which is easy to conflate). Attribution for the bill lives on the
      // payment rows and in the payment audit trail.
      notes: (input.notes ?? '').trim() || null,
    })
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }

  revalidateAll()
  return { ok: true, obligationId: data.id }
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

  // Advance each bill's next due date past the newest debit we just reconciled.
  // Uses the same schedule-anchored helper as the manual path, so a next_due_date
  // that had already drifted ahead is corrected here too rather than left stale.
  // Non-fatal if it fails; the payments are already saved.
  for (const [obligationId, posted] of latestPosted) {
    const ob = obligationById.get(obligationId)
    if (!ob) continue
    const anchor = ob.due_date || ob.next_due_date || ''
    const nextDue = nextScheduledDueDate(anchor, ob.frequency || 'Monthly', posted)
    if (nextDue && nextDue !== ob.next_due_date) {
      await supabase
        .from('cash_obligations')
        .update({ next_due_date: nextDue })
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
  // `pending` means "logging a bill I still owe", so a check number is not required
  // yet — the check may not be written. A non-pending check is one the owner has
  // physically written, and still must carry its number for bank matching.
  const invalid = validatePaymentBasics(input, {
    allowUnwrittenCheck: Boolean(input.pending),
  })
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
      // `|| null` matters: an unwritten check must store NULL, not '', so that
      // "has a check number" is one unambiguous test everywhere downstream.
      check_number: method === 'check' ? (input.checkNumber ?? '').trim() || null : null,
      // A check is "written" unless this is a bill being logged ahead of writing it.
      // Supplying a number always means it exists, whatever `pending` says — the
      // owner cannot have a number for a check that isn't written.
      check_written:
        method !== 'check' ||
        !input.pending ||
        Boolean((input.checkNumber ?? '').trim()),
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
      // A logged invoice awaiting payment, by either route. No longer gated on
      // method: a bill to be paid by a not-yet-written check is equally pending.
      pending_draft: Boolean(input.pending),
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
 * Match cleared bank checks to the bills they paid, writing only the certain ones.
 *
 * Re-derives everything from the database rather than trusting anything from the client,
 * mirroring reconcileAchFromBank. Normally this runs automatically after a bank sync;
 * this action exists so the owner can also trigger it directly.
 */
export async function autoClearFromBank(): Promise<{
  ok: boolean
  error?: string
  cleared?: number
  needsReview?: number
}> {
  const supabase = await createClient()
  const actor = await currentActor()
  if (!actor) return { ok: false, error: 'You must be signed in.' }

  try {
    const summary = await runAutoClear(supabase, actor)
    revalidateAll()
    return { ok: true, cleared: summary.cleared, needsReview: summary.needsReview }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not match bank checks.' }
  }
}

/**
 * Resolve one item the matcher was not confident about.
 *
 * Three shapes, matching the three uncertain tiers:
 *  - 'accept_bank'   an amount mismatch, where the bank figure is the truth. Corrects the
 *                    recorded amount and clears it.
 *  - 'link'          a bill whose payment was never recorded. Creates the cleared payment
 *                    row that should have existed, against the obligation the owner picks.
 *  - 'dismiss'       not a bill payment (ordinary untracked spending). Recorded so the
 *                    same check does not surface again.
 *
 * The obligation id is validated against the candidates the matcher itself produced, so a
 * tampered form cannot clear an arbitrary bill.
 */
export async function resolveAutoClearItem(input: {
  transactionId: string
  choice: 'accept_bank' | 'link' | 'dismiss'
  paymentId?: string
  obligationId?: string
}): Promise<ActionResult> {
  const { transactionId, choice } = input
  if (!transactionId) return { ok: false, error: 'No bank transaction was specified.' }

  const supabase = await createClient()
  const actor = await currentActor()
  if (!actor) return { ok: false, error: 'You must be signed in.' }

  // Re-run the matcher and find this row in its output. This is what makes the action
  // safe: the choice is only honoured for a row the matcher actually flagged, with the
  // options it actually offered.
  const { review } = await getAutoClearCandidates()
  const item = review.find((r) => r.transactionId === transactionId)
  if (!item) {
    return { ok: false, error: 'That item is no longer waiting for review. Refresh the page.' }
  }

  const { data: txn, error: txnErr } = await supabase
    .from('financial_transactions')
    .select('id, transaction_date, amount, description')
    .eq('id', transactionId)
    .is('deleted_at', null)
    .maybeSingle()
  if (txnErr) return { ok: false, error: txnErr.message }
  if (!txn) return { ok: false, error: 'That bank transaction no longer exists.' }
  const postedDate = (txn.transaction_date ?? '').slice(0, 10)
  const bankAmount = Number(txn.amount) || 0

  if (choice === 'dismiss') {
    // No payment to touch. Recorded as an audit row against no payment would violate the
    // FK, so dismissal is stored on the transaction itself via a note the matcher reads
    // as "already considered".
    const { error } = await supabase
      .from('financial_transactions')
      .update({ bill_match_dismissed_at: new Date().toISOString() })
      .eq('id', transactionId)
    if (error) return { ok: false, error: error.message }
    revalidateAll()
    return { ok: true }
  }

  if (choice === 'accept_bank') {
    const paymentId = input.paymentId ?? item.paymentId
    if (!paymentId || paymentId !== item.paymentId) {
      return { ok: false, error: 'That payment does not match this bank row.' }
    }
    const { error } = await supabase
      .from('obligation_payments')
      .update({
        amount: bankAmount,
        status: 'cleared',
        cleared_date: postedDate,
        cleared_transaction_id: transactionId,
      })
      .eq('id', paymentId)
      .eq('status', 'outstanding')
    if (error) {
      if (error.code === '23505') {
        return { ok: false, error: 'That bank row already cleared another payment.' }
      }
      return { ok: false, error: error.message }
    }
    await supabase.from('obligation_payment_audit').insert({
      payment_id: paymentId,
      action: 'cleared',
      detail: {
        source: 'bank_review_accept',
        transactionId,
        clearedDate: postedDate,
        correctedAmountTo: bankAmount,
        recordedAmountWas: item.recordedAmount ?? null,
      },
      created_by: actor,
    })
    revalidateAll()
    return { ok: true, paymentId }
  }

  // choice === 'link': create the payment row that was never recorded.
  const obligationId = input.obligationId
  if (!obligationId) return { ok: false, error: 'Choose which bill this check paid.' }
  if (!item.candidateObligationIds.includes(obligationId)) {
    return { ok: false, error: 'That bill was not one of the suggested matches.' }
  }

  const { data: obligation, error: obErr } = await supabase
    .from('cash_obligations')
    .select('id, obligation_name, vendor_name, recurring, status, due_date, next_due_date, frequency')
    .eq('id', obligationId)
    .maybeSingle()
  if (obErr) return { ok: false, error: obErr.message }
  if (!obligation) return { ok: false, error: 'That bill no longer exists.' }
  if (obligation.status === 'Paid') {
    return { ok: false, error: 'That bill is already marked paid.' }
  }

  const { data: inserted, error: insErr } = await supabase
    .from('obligation_payments')
    .insert({
      obligation_id: obligationId,
      amount: bankAmount,
      // The payment happened when the check cleared, which is the only date the bank
      // gives us. Dating it today would misplace a real payment in the cash history.
      payment_date: postedDate,
      payment_method: 'check',
      check_number: item.checkNumber,
      check_written: true,
      status: 'cleared',
      cleared_date: postedDate,
      cleared_transaction_id: transactionId,
      payee_name: obligation.vendor_name ?? null,
      memo: 'Matched from bank statement',
    })
    .select('id')
    .single()
  if (insErr) {
    if (insErr.code === '23505') {
      return { ok: false, error: 'That bank row already cleared another payment.' }
    }
    return { ok: false, error: insErr.message }
  }

  // A one-time bill is settled by this payment. A recurring bill rolls forward instead,
  // matching recordPayment's owner-approved default so a monthly bill never vanishes
  // from the forecast.
  if (obligation.recurring) {
    // Anchored on the bill's own schedule, exactly as the manual and ACH paths do, so a
    // next_due_date that had drifted is corrected rather than left stale.
    const anchor = obligation.due_date || obligation.next_due_date || ''
    const next = nextScheduledDueDate(anchor, obligation.frequency || 'Monthly', postedDate)
    if (next && next !== obligation.next_due_date) {
      await supabase.from('cash_obligations').update({ next_due_date: next }).eq('id', obligationId)
    }
  } else {
    await supabase.from('cash_obligations').update({ status: 'Paid' }).eq('id', obligationId)
  }

  await supabase.from('obligation_payment_audit').insert({
    payment_id: inserted.id,
    action: 'created',
    detail: {
      source: 'bank_review_link',
      transactionId,
      checkNumber: item.checkNumber,
      clearedDate: postedDate,
      amount: bankAmount,
      obligationId,
    },
    created_by: actor,
  })

  revalidateAll()
  return { ok: true, paymentId: inserted.id }
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
    // obligation_id is needed to REOPEN a one-time bill this void un-pays.
    .select('id, status, obligation_id')
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

  // Voiding is the exact inverse of the closing logic in recordPayment, so it must
  // re-run the same test: a voided check never left the account, so that money is
  // owed again and a bill it had closed has to REOPEN.
  //
  // Without this, voiding the payment that closed a one-time bill left the bill
  // marked Paid — off the payable list, out of the forecast — while the invoice
  // was genuinely still outstanding. That is the same double-count as the
  // never-closing bug, just pointing the other way (money owed and invisible,
  // which is the more expensive direction to be wrong in).
  if (existing.obligation_id) {
    const { data: ob } = await supabase
      .from('cash_obligations')
      .select('id, amount, status, recurring')
      .eq('id', existing.obligation_id)
      .maybeSingle()
    // Recurring bills are excluded for the same reason as in recordPayment: they
    // track periods by due date, not by a Paid status.
    if (ob && !ob.recurring) {
      const { data: paidRows } = await supabase
        .from('obligation_payments')
        .select('amount')
        .eq('obligation_id', existing.obligation_id)
        .neq('status', 'void')
      const paidTotal = (paidRows ?? []).reduce(
        (sum, r) => sum + (Number(r.amount) || 0),
        0,
      )
      const nextStatus = resolveOneTimeBillStatus(Number(ob.amount), paidTotal)
      if (nextStatus !== ob.status) {
        await supabase
          .from('cash_obligations')
          .update({ status: nextStatus })
          .eq('id', existing.obligation_id)
      }
    }
  }

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
 * Turn a recorded-but-never-sent payment back into an unpaid invoice due.
 *
 * Why this exists: five entries here were logged as payments when they were
 * really invoices that had ARRIVED but not been paid (they were the only
 * outstanding rows with no check number). A payment and an invoice make opposite
 * claims about the bank balance, so the mistake was expensive in both directions
 * at once: `sumOutstanding` subtracts every outstanding row from spendable cash
 * (it filters on STATUS, not method, so ACH rows count too), while the invoice
 * was missing from the payable list and the upcoming-outflow forecast. The money
 * was treated as already gone AND as not owed.
 *
 * Deliberately DELETES the payment row rather than voiding it (owner's choice): a
 * void leaves a "voided check" in the history that never existed. The audit table
 * cascades on delete, so provenance is written onto the new invoice's notes —
 * otherwise the trail would vanish entirely.
 */
export async function convertPaymentToInvoice(
  paymentId: string,
): Promise<{ ok: boolean; error?: string; obligationId?: string }> {
  if (!paymentId) return { ok: false, error: 'No payment was specified.' }

  const supabase = await createClient()

  const { data: p, error: readErr } = await supabase
    .from('obligation_payments')
    .select(
      'id, status, obligation_id, amount, payment_date, payment_method, check_number, payee_name, purpose, memo',
    )
    .eq('id', paymentId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!p) return { ok: false, error: 'That payment no longer exists.' }

  // Only an OUTSTANDING payment can become an invoice. A cleared payment has been
  // seen leaving the bank, so the money is genuinely gone and calling it an unpaid
  // invoice would overstate cash by its amount. A void is already not counted.
  if (p.status !== 'outstanding') {
    return {
      ok: false,
      error:
        p.status === 'cleared'
          ? 'This payment already cleared the bank, so the money has left the account. Only an uncleared payment can be turned back into an invoice.'
          : 'This payment is void, so it is not counted as paid or owed. Enter a new invoice instead.',
    }
  }

  // A payment attached to a scheduled bill must not be converted: the bill ALREADY
  // represents the amount owed, so adding an invoice beside it would double-count
  // the obligation and leave the original bill looking part-paid by a payment that
  // no longer exists. Voiding is the correct tool there, and it reopens the bill.
  if (p.obligation_id) {
    return {
      ok: false,
      error:
        'This payment is attached to a scheduled bill, which already tracks what is owed. Void the payment instead — that reopens the bill without creating a duplicate.',
    }
  }

  const payee = (p.payee_name ?? '').trim()
  const purpose = (p.purpose ?? '').trim()
  const dueDate = (p.payment_date ?? '').slice(0, 10)
  if (!dueDate) {
    return { ok: false, error: 'This payment has no date, so the invoice would have no due date.' }
  }

  // The invoice needs a name. `purpose` is what the owner actually typed ("Weekly
  // Bulk COGS"), so prefer it; fall back to the payee so the row is never nameless.
  const name = purpose || (payee ? `Invoice — ${payee}` : '')
  if (!name) {
    return {
      ok: false,
      error: 'This payment has no payee or purpose, so there is nothing to name the invoice.',
    }
  }

  // Provenance, because deleting the payment cascades its audit rows away.
  const trail = [
    `Converted from a recorded ${p.payment_method === 'ach' ? 'ACH' : 'check'} payment dated ${dueDate}`,
    p.check_number ? `check #${p.check_number}` : null,
    'the payment had not actually been sent',
  ]
    .filter(Boolean)
    .join(' · ')
  const notes = [(p.memo ?? '').trim() || null, trail].filter(Boolean).join('\n')

  // Reuse createBillDue so a converted invoice is byte-for-byte the same shape as
  // a hand-entered one — including its deliberate payment_method 'Check', which
  // keeps the ACH matcher from auto-closing it against an unrelated bank debit.
  const created = await createBillDue({
    obligationName: name,
    vendorName: payee || undefined,
    amount: Number(p.amount),
    dueDate,
    notes,
  })
  if (!created.ok || !created.obligationId) {
    return { ok: false, error: created.error ?? 'Could not create the invoice.' }
  }

  // Insert BEFORE delete, then compensate on failure. The reverse order risks
  // destroying the record with nothing to replace it; this order's worst case is a
  // duplicate we immediately remove. Leaving both would double-count the money.
  const { error: delErr } = await supabase
    .from('obligation_payments')
    .delete()
    .eq('id', paymentId)

  if (delErr) {
    const { error: rollbackErr } = await supabase
      .from('cash_obligations')
      .delete()
      .eq('id', created.obligationId)
    if (rollbackErr) {
      // Both writes failed to settle. Say so loudly with the ids: the books are
      // now double-counting this amount and a human has to pick one.
      console.log('[v0] convertPaymentToInvoice: rollback FAILED', {
        paymentId,
        obligationId: created.obligationId,
        delErr: delErr.message,
        rollbackErr: rollbackErr.message,
      })
      return {
        ok: false,
        error: `Serious problem: the invoice was created but the old payment could not be removed, and undoing the invoice also failed. This amount is now counted twice. Invoice id ${created.obligationId}, payment id ${paymentId}.`,
      }
    }
    return { ok: false, error: `Could not remove the old payment record: ${delErr.message}` }
  }

  revalidateAll()
  return { ok: true, obligationId: created.obligationId }
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

/**
 * Undo a clear that was recorded by mistake, returning the payment to outstanding.
 *
 * This is NOT the same as voiding. Void says "this payment never happened" and
 * removes the money from the float entirely; un-clearing says "it hasn't left the
 * bank yet", which puts the amount back into outstanding so spendable cash drops
 * again. Using void for a misclick would overstate spendable cash by the amount.
 *
 * `cleared_transaction_id` must be released too, or the matched bank row stays
 * claimed forever: there is a unique index on that column, so the real debit could
 * never be attached to this payment on a later, correct attempt.
 */
export async function unclearPayment(paymentId: string): Promise<ActionResult> {
  if (!paymentId) return { ok: false, error: 'No payment was specified.' }

  const supabase = await createClient()
  const actor = await currentActor()

  const { data: existing, error: readErr } = await supabase
    .from('obligation_payments')
    .select('id, status, cleared_date, cleared_transaction_id')
    .eq('id', paymentId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!existing) return { ok: false, error: 'That payment no longer exists.' }
  // A void row is intentionally excluded: reviving it would resurrect money the
  // owner deliberately removed. Voids are undone by re-entering the payment.
  if (existing.status !== 'cleared') {
    return { ok: false, error: 'Only a cleared payment can be moved back to outstanding.' }
  }

  const { error: updErr } = await supabase
    .from('obligation_payments')
    .update({ status: 'outstanding', cleared_date: null, cleared_transaction_id: null })
    .eq('id', paymentId)
  if (updErr) return { ok: false, error: updErr.message }

  await supabase.from('obligation_payment_audit').insert({
    payment_id: paymentId,
    action: 'uncleared',
    detail: {
      source: 'manual-correction',
      // Kept so the trail shows what was undone, not merely that something was.
      previousClearedDate: existing.cleared_date,
      releasedTransactionId: existing.cleared_transaction_id,
    },
    created_by: actor,
  })

  revalidateAll()
  return { ok: true, paymentId }
}

/**
 * Attach a check number to an outstanding payment once the check is actually
 * written. Completes the "log the invoice now, write the check later" flow: until
 * the number exists the payment shows as expected rather than written, and
 * check-resolution cannot match it to the bank (it skips numberless payments).
 */
export async function recordCheckNumber(
  paymentId: string,
  checkNumber: string,
): Promise<ActionResult> {
  if (!paymentId) return { ok: false, error: 'No payment was specified.' }
  const num = (checkNumber ?? '').trim()
  if (!num) return { ok: false, error: 'Enter the check number.' }

  const supabase = await createClient()
  const actor = await currentActor()

  const { data: existing, error: readErr } = await supabase
    .from('obligation_payments')
    .select('id, status, payment_method, check_number, check_written')
    .eq('id', paymentId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!existing) return { ok: false, error: 'That payment no longer exists.' }
  if (existing.status !== 'outstanding') {
    return { ok: false, error: 'Only an outstanding payment can be updated.' }
  }
  // Switching an ACH to a check would change how the money is expected to move;
  // that is a different decision than filling in a number, so it is refused here.
  if (existing.payment_method !== 'check') {
    return { ok: false, error: 'This payment is set to ACH, not check.' }
  }

  // Recording a number proves the check exists, so it also becomes "written". That
  // promotes it out of payee-only matching and into amount+date matching, which is
  // the point of capturing the number at all.
  const { error: updErr } = await supabase
    .from('obligation_payments')
    .update({ check_number: num, check_written: true })
    .eq('id', paymentId)
  if (updErr) return { ok: false, error: updErr.message }

  await supabase.from('obligation_payment_audit').insert({
    payment_id: paymentId,
    action: 'updated',
    detail: {
      checkNumber: num,
      previousCheckNumber: existing.check_number,
      // Records the state transition, not just the value, so the trail explains why
      // this payment's matching behaviour changed.
      checkWrittenBefore: existing.check_written,
      checkWrittenAfter: true,
    },
    created_by: actor,
  })

  revalidateAll()
  return { ok: true, paymentId }
}

export type EditPaymentInput = {
  paymentId: string
  amount: number
  paymentDate: string
  payeeName?: string
  checkNumber?: string
  memo?: string
  purpose?: string
}

/**
 * Correct a payment or check that was already recorded.
 *
 * Previously the only way to fix a typo was to void the payment and re-enter it, which
 * left a void in the audit trail implying the money never moved. A correction and a
 * cancellation are different events and should not look identical afterwards.
 *
 * Two rules make this safe:
 *
 * 1. Editing the amount RE-DERIVES the parent bill's status, exactly as voidPayment
 *    does. Whether a bill is Paid is a function of its payments, so changing a payment
 *    and leaving the status alone silently desyncs them — correcting a $5,000 check
 *    down to $500 would leave the bill marked Paid with $4,500 still genuinely owed,
 *    which is money owed and invisible, the more expensive direction to be wrong in.
 * 2. A VOID payment is refused. Void means "this money never moved", so there is no
 *    amount to correct; editing one would assert a specific figure for a payment that
 *    did not happen.
 *
 * Editing a CLEARED payment's amount or date is allowed but flagged: the caller re-sends
 * with acknowledgedReconciliationBreak once the owner has seen the warning, and the
 * audit entry records that the bank match was knowingly broken.
 */
export async function editPayment(
  input: EditPaymentInput,
  acknowledgedReconciliationBreak = false,
): Promise<ActionResult & { reconciliationWarning?: string }> {
  if (!input.paymentId) return { ok: false, error: 'No payment was specified.' }

  const basicError = validatePaymentEdit({
    amount: input.amount,
    paymentDate: input.paymentDate,
  })
  if (basicError) return { ok: false, error: basicError }

  const supabase = await createClient()
  const actor = await currentActor()

  const { data: existing, error: readErr } = await supabase
    .from('obligation_payments')
    .select(
      'id, status, amount, payment_date, obligation_id, payee_name, check_number, memo, purpose',
    )
    .eq('id', input.paymentId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  if (!existing) return { ok: false, error: 'That payment no longer exists.' }

  // Rule 2 above.
  if (existing.status === 'void') {
    return {
      ok: false,
      error:
        'This payment is voided, so there is no payment to correct. Record a new payment instead.',
    }
  }

  const breaksReconciliation = editBreaksReconciliation(
    {
      amount: Number(existing.amount),
      paymentDate: String(existing.payment_date),
      status: String(existing.status),
    },
    { amount: Number(input.amount), paymentDate: input.paymentDate },
  )

  // Returned as a WARNING, not an error, so the UI can show it and let the owner
  // confirm. This must stop the FIRST attempt (otherwise the warning is never seen)
  // and allow the second.
  if (breaksReconciliation && !acknowledgedReconciliationBreak) {
    return {
      ok: false,
      reconciliationWarning:
        'This check is marked cleared against a bank transaction. Changing its amount or date will make this record disagree with your bank statement.',
    }
  }

  const nextAmount = Number(input.amount)
  const { error: updErr } = await supabase
    .from('obligation_payments')
    .update({
      amount: nextAmount,
      payment_date: input.paymentDate,
      // Trimmed to null rather than '', so an emptied field reads as "not recorded"
      // everywhere, matching how these columns are read elsewhere.
      payee_name: (input.payeeName ?? '').trim() || null,
      check_number: (input.checkNumber ?? '').trim() || null,
      memo: (input.memo ?? '').trim() || null,
      purpose: (input.purpose ?? '').trim() || null,
    })
    .eq('id', input.paymentId)
  if (updErr) return { ok: false, error: updErr.message }

  // Rule 1 above. Same recurring guard as voidPayment: recurring bills track periods by
  // due date rather than a Paid status, so routing one through here would close it and
  // drop it out of the forecast entirely.
  if (existing.obligation_id) {
    const { data: ob } = await supabase
      .from('cash_obligations')
      .select('id, amount, status, recurring')
      .eq('id', existing.obligation_id)
      .maybeSingle()
    if (ob && !ob.recurring) {
      const { data: paidRows } = await supabase
        .from('obligation_payments')
        .select('amount')
        .eq('obligation_id', existing.obligation_id)
        .neq('status', 'void')
      const paidTotal = (paidRows ?? []).reduce(
        (sum, r) => sum + (Number(r.amount) || 0),
        0,
      )
      const nextStatus = resolveOneTimeBillStatus(Number(ob.amount), paidTotal)
      if (nextStatus !== ob.status) {
        await supabase
          .from('cash_obligations')
          .update({ status: nextStatus })
          .eq('id', existing.obligation_id)
      }
    }
  }

  await supabase.from('obligation_payment_audit').insert({
    payment_id: input.paymentId,
    action: 'updated',
    detail: {
      edited: true,
      previousAmount: Number(existing.amount),
      newAmount: nextAmount,
      previousPaymentDate: existing.payment_date,
      newPaymentDate: input.paymentDate,
      previousPayeeName: existing.payee_name,
      previousCheckNumber: existing.check_number,
      previousMemo: existing.memo,
      previousPurpose: existing.purpose,
      // Recorded so a later reconciliation mismatch is explainable rather than
      // looking like corrupted data.
      reconciliationBreakAcknowledged: breaksReconciliation || undefined,
      statusAtEdit: existing.status,
    },
    created_by: actor,
  })

  revalidateAll()
  return { ok: true, paymentId: input.paymentId }
}
