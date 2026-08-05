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
  validatePaymentBasics,
  validateBillDueBasics,
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

  const isCleared = method === 'ach'
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
