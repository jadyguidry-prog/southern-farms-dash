'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import {
  cadenceToFrequency,
  matchVendor,
  type VendorMatchRule,
} from '@/lib/transactions'
import {
  classificationEffect,
  GENERIC_CLASSIFICATIONS,
  type GenericClassification,
} from '@/lib/transaction-groups'

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
 * Apply an update to a large set of ids in chunks.
 *
 * A single `.in()` with hundreds of UUIDs can exceed the request URL limit, and
 * a group here can legitimately hold 40+ transactions.
 */
async function updateInChunks(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
  patch: Record<string, unknown>,
): Promise<string | null> {
  const size = 200
  for (let i = 0; i < ids.length; i += size) {
    const { error } = await supabase
      .from('financial_transactions')
      .update(patch)
      .in('id', ids.slice(i, i + size))
    if (error) return error.message
  }
  return null
}

/** Insert a match rule unless an identical one already exists. */
async function ensureRule(
  supabase: Awaited<ReturnType<typeof createClient>>,
  vendorId: string,
  matchText: string,
) {
  const phrase = matchText.trim().toUpperCase()
  if (phrase.replace(/[^A-Z]/g, '').length < 4) return

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
      priority: 5,
    })
  }
}

/**
 * Find a vendor by name without creating one, matching case-insensitively.
 * Used to honour "do not create duplicate vendors" when the owner types a name
 * that already exists in the directory under different capitalization.
 */
async function findVendorByName(
  supabase: Awaited<ReturnType<typeof createClient>>,
  name: string,
): Promise<string | null> {
  const trimmed = name.trim()
  if (!trimmed) return null

  const { data } = await supabase
    .from('vendors')
    .select('id, name, display_name')
    .is('deleted_at', null)

  const target = trimmed.toLowerCase()
  for (const v of data ?? []) {
    const candidates = [v.name, v.display_name]
      .map((n) => String(n ?? '').trim().toLowerCase())
      .filter(Boolean)
    if (candidates.includes(target)) return String(v.id)
  }
  return null
}

export type GroupActionInput = {
  transactionIds: string[]
  /** Existing vendor to assign, or empty when creating a new one. */
  vendorId?: string
  /** When set, create (or reuse) a vendor with this name and assign it. */
  newVendorName?: string
  category?: string
  /** Save a conservative rule so future imports match automatically. */
  createRule?: boolean
  ruleText?: string
}

export type GroupActionResult = ActionResult & {
  vendorId?: string
  vendorCreated?: boolean
  ruleCreated?: boolean
  updated?: number
}

/**
 * Assign an entire payee group to a vendor in one step.
 *
 * This is the core of grouped review: one decision covers every transaction
 * that shares the payee, and optionally teaches the matcher so the same lines
 * are recognized on the next import instead of returning to the queue.
 */
export async function applyGroupAction(
  input: GroupActionInput,
): Promise<GroupActionResult> {
  const ids = input.transactionIds ?? []
  if (ids.length === 0) return { ok: false, error: 'No transactions in group.' }

  const supabase = await createClient()

  let vendorId = input.vendorId?.trim() || ''
  let vendorCreated = false

  if (!vendorId && input.newVendorName?.trim()) {
    const name = input.newVendorName.trim()
    // Reuse an existing vendor rather than creating a near-duplicate.
    const existingId = await findVendorByName(supabase, name)
    if (existingId) {
      vendorId = existingId
    } else {
      const { data, error } = await supabase
        .from('vendors')
        .insert({ name, category: input.category?.trim() || null })
        .select('id')
        .single()
      if (error) return { ok: false, error: error.message }
      vendorId = String(data.id)
      vendorCreated = true
    }
  }

  if (!vendorId) {
    return { ok: false, error: 'Choose an existing vendor or enter a new name.' }
  }

  const patch: Record<string, unknown> = {
    vendor_id: vendorId,
    review_status: 'matched',
  }
  if (input.category?.trim()) patch.expense_category = input.category.trim()

  const error = await updateInChunks(supabase, ids, patch)
  if (error) return { ok: false, error }

  let ruleCreated = false
  if (input.createRule && input.ruleText?.trim()) {
    await ensureRule(supabase, vendorId, input.ruleText)
    ruleCreated = true
  }

  revalidateAll()
  return { ok: true, vendorId, vendorCreated, ruleCreated, updated: ids.length }
}

/**
 * Bulk-classify lines that name no payee (checks, deposits, transfers).
 *
 * The classification decides the stored `transaction_type`, which is what keeps
 * spend math honest — a card payment or account transfer must never count as
 * vendor spend or the purchases behind it get counted twice.
 */
export async function classifyGenericGroup(
  transactionIds: string[],
  classification: GenericClassification,
): Promise<ActionResult & { updated?: number }> {
  const ids = transactionIds ?? []
  if (ids.length === 0) return { ok: false, error: 'No transactions in group.' }
  if (!GENERIC_CLASSIFICATIONS.includes(classification)) {
    return { ok: false, error: 'Unknown classification.' }
  }

  const effect = classificationEffect(classification)
  const patch: Record<string, unknown> = { review_status: effect.reviewStatus }
  if (effect.transactionType) patch.transaction_type = effect.transactionType
  if (effect.category) patch.expense_category = effect.category

  const supabase = await createClient()
  const error = await updateInChunks(supabase, ids, patch)
  if (error) return { ok: false, error }

  revalidateAll()
  return { ok: true, updated: ids.length }
}

/**
 * Re-run vendor matching over every row still awaiting review.
 *
 * Needed after new vendors or rules are added: rows that had nothing to match
 * against on import can now resolve. Only unreviewed/needs_review rows are
 * touched, so a decision the owner already made is never overwritten.
 */
export async function rematchUnreviewed(): Promise<
  ActionResult & { matched?: number; scanned?: number }
> {
  const supabase = await createClient()

  const [{ data: ruleRows }, { data: txRows }] = await Promise.all([
    supabase.from('vendor_match_rules').select('*').eq('active', true),
    supabase
      .from('financial_transactions')
      .select('id, normalized_description, vendor_id')
      .is('deleted_at', null)
      .in('review_status', ['needs_review', 'unreviewed'])
      .limit(5000),
  ])

  const rules: VendorMatchRule[] = (ruleRows ?? []).map((r) => ({
    id: String(r.id),
    vendor_id: String(r.vendor_id),
    match_text: String(r.match_text),
    match_type: r.match_type,
    priority: Number(r.priority),
    active: Boolean(r.active),
  }))

  // Group ids by the vendor they resolve to, so each vendor is one update.
  const byVendor = new Map<string, string[]>()
  for (const row of txRows ?? []) {
    const match = matchVendor(String(row.normalized_description ?? ''), rules)
    if (!match || match.confidence < 90) continue
    const list = byVendor.get(match.vendorId)
    if (list) list.push(String(row.id))
    else byVendor.set(match.vendorId, [String(row.id)])
  }

  let matched = 0
  for (const [vendorId, ids] of byVendor) {
    const error = await updateInChunks(supabase, ids, {
      vendor_id: vendorId,
      review_status: 'matched',
    })
    if (error) return { ok: false, error }
    matched += ids.length
  }

  revalidateAll()
  return { ok: true, matched, scanned: (txRows ?? []).length }
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
