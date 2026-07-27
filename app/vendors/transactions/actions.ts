'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { cadenceToFrequency } from '@/lib/transactions'

type ActionResult = { ok: boolean; error?: string }

function revalidateAll() {
  revalidatePath('/vendors')
  revalidatePath('/vendors/transactions')
  revalidatePath('/cash-flow')
  revalidatePath('/')
}

/**
 * Assign a vendor to transactions and mark them reviewed.
 *
 * When `learn` is set we also store a match rule from the transaction's
 * normalized description, so the same statement line is recognized on the next
 * import. This is how the matcher improves without any hardcoded merchant list.
 */
export async function assignVendor(
  transactionIds: string[],
  vendorId: string,
  learn: boolean,
): Promise<ActionResult> {
  if (transactionIds.length === 0) return { ok: false, error: 'No rows selected.' }
  if (!vendorId) return { ok: false, error: 'Choose a vendor first.' }

  const supabase = await createClient()

  const { error } = await supabase
    .from('financial_transactions')
    .update({ vendor_id: vendorId, review_status: 'matched' })
    .in('id', transactionIds)

  if (error) return { ok: false, error: error.message }

  if (learn) {
    const { data: rows } = await supabase
      .from('financial_transactions')
      .select('normalized_description')
      .in('id', transactionIds)

    const phrases = new Set(
      (rows ?? [])
        .map((r) => String(r.normalized_description ?? '').trim())
        .filter((p) => p.length >= 4),
    )

    for (const phrase of phrases) {
      // Don't create a second identical rule if one already exists.
      const { data: existing } = await supabase
        .from('vendor_match_rules')
        .select('id')
        .eq('vendor_id', vendorId)
        .eq('match_text', phrase)
        .maybeSingle()

      if (!existing) {
        await supabase.from('vendor_match_rules').insert({
          vendor_id: vendorId,
          match_text: phrase,
          match_type: 'contains',
          // Learned rules are the most specific evidence we have, so they take
          // precedence over the name-derived rules seeded from the directory.
          priority: 5,
        })
      }
    }
  }

  revalidateAll()
  return { ok: true }
}

export async function setReviewStatus(
  transactionIds: string[],
  status: 'unreviewed' | 'matched' | 'needs_review' | 'excluded',
): Promise<ActionResult> {
  if (transactionIds.length === 0) return { ok: false, error: 'No rows selected.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('financial_transactions')
    .update({ review_status: status })
    .in('id', transactionIds)

  if (error) return { ok: false, error: error.message }
  revalidateAll()
  return { ok: true }
}

export async function setTransactionCategory(
  transactionIds: string[],
  category: string,
): Promise<ActionResult> {
  if (transactionIds.length === 0) return { ok: false, error: 'No rows selected.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('financial_transactions')
    .update({ expense_category: category || null })
    .in('id', transactionIds)

  if (error) return { ok: false, error: error.message }
  revalidateAll()
  return { ok: true }
}

/** Soft-delete so the row stops counting toward spend but stays auditable. */
export async function deleteTransactions(
  transactionIds: string[],
): Promise<ActionResult> {
  if (transactionIds.length === 0) return { ok: false, error: 'No rows selected.' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('financial_transactions')
    .update({ deleted_at: new Date().toISOString() })
    .in('id', transactionIds)

  if (error) return { ok: false, error: error.message }
  revalidateAll()
  return { ok: true }
}

/**
 * Turn an approved recurring suggestion into a real cash obligation.
 *
 * The amount and frequency come from observed history, and the vendor name is
 * written so the existing obligation views (which match by name) pick it up.
 * Nothing is created without the owner pressing approve.
 */
export async function approveRecurringSuggestion(input: {
  vendorId: string
  vendorName: string
  label: string
  amount: number
  cadence: string
  nextDueDate: string
  category: string
}): Promise<ActionResult> {
  const supabase = await createClient()

  const frequency = cadenceToFrequency(
    input.cadence as 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual',
  )
  if (!frequency) return { ok: false, error: 'Unrecognized frequency.' }
  if (!(input.amount > 0)) {
    return { ok: false, error: 'Amount must be greater than zero.' }
  }
  if (!input.nextDueDate) {
    return { ok: false, error: 'Choose the next due date.' }
  }

  // Avoid creating a duplicate obligation for the same vendor and label.
  const { data: existing } = await supabase
    .from('cash_obligations')
    .select('id')
    .eq('vendor_name', input.vendorName)
    .eq('obligation_name', input.label)
    .maybeSingle()

  if (existing) {
    return { ok: false, error: 'An obligation for this vendor already exists.' }
  }

  const { error } = await supabase.from('cash_obligations').insert({
    obligation_name: input.label,
    vendor_name: input.vendorName,
    amount: input.amount,
    frequency,
    due_date: input.nextDueDate,
    next_due_date: input.nextDueDate,
    category: input.category || null,
    recurring: true,
    status: 'Pending',
    active: true,
  })

  if (error) return { ok: false, error: error.message }

  // Flag the underlying transactions so the suggestion isn't offered again.
  await supabase
    .from('financial_transactions')
    .update({ is_recurring: true })
    .eq('vendor_id', input.vendorId)
    .is('deleted_at', null)

  revalidateAll()
  return { ok: true }
}
