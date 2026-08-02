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
export function validatePaymentBasics(input: {
  amount: number
  paymentDate: string
  paymentMethod: string
  checkNumber?: string
}): string | null {
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
  // A check with no number cannot be matched to the bank feed later, which is the
  // whole reason the float number can be trusted. Same rule as check-resolution.
  if (input.paymentMethod === 'check' && !(input.checkNumber ?? '').trim()) {
    return 'Enter the check number.'
  }
  return null
}
