'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

type ActionResult = { ok: boolean; error?: string; updated?: number }

function revalidateAll() {
  revalidatePath('/category-review')
  revalidatePath('/cash-flow')
  revalidatePath('/admin')
  revalidatePath('/ai-advisor')
  revalidatePath('/')
}

type SB = Awaited<ReturnType<typeof createClient>>

async function actorEmail(supabase: SB): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser()
    return data.user?.email ?? null
  } catch {
    return null
  }
}

/** Apply a patch to many ids in chunks to stay under the request URL limit. */
async function updateInChunks(
  supabase: SB,
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

async function insertAuditInChunks(
  supabase: SB,
  rows: Record<string, unknown>[],
): Promise<string | null> {
  const size = 500
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await supabase
      .from('transaction_audit_log')
      .insert(rows.slice(i, i + size))
    if (error) return error.message
  }
  return null
}

/**
 * Approve a category merge: rewrite every stored `expense_category` in
 * `fromCategories` to `toCategory`, recording each change in the audit log so
 * the whole action can be reversed as a unit. Nothing is touched until this
 * runs — proposals are inert suggestions.
 */
export async function approveMerge(input: {
  fromCategories: string[]
  toCategory: string
  reason?: string
}): Promise<ActionResult & { bulkActionId?: string }> {
  const from = (input.fromCategories ?? []).filter((v) => v?.trim())
  const to = (input.toCategory ?? '').trim()
  if (from.length === 0 || !to) {
    return { ok: false, error: 'Nothing to merge.' }
  }

  const supabase = await createClient()
  const actor = await actorEmail(supabase)
  const bulkActionId = randomUUID()

  // A merge is display-only. We deliberately DO NOT touch any stored
  // `expense_category`; instead we measure the impact for the confirmation
  // record and persist an approved proposal, which the reporting layer reads as
  // an alias. The owner's raw data is never overwritten, so a merge is always
  // perfectly reversible by simply retiring the proposal.
  const { data: rows, error: fetchErr } = await supabase
    .from('financial_transactions')
    .select('amount, vendor_id')
    .is('deleted_at', null)
    .in('expense_category', from)
  if (fetchErr) return { ok: false, error: fetchErr.message }

  const targets = rows ?? []
  const totalAmount = targets.reduce(
    (s, r) => s + Math.abs(Number(r.amount) || 0),
    0,
  )
  const vendorCount = new Set(
    targets.map((r) => r.vendor_id).filter(Boolean),
  ).size

  const { error: propErr } = await supabase
    .from('category_merge_proposals')
    .insert({
      from_categories: from,
      to_category: to,
      status: 'approved',
      transaction_count: targets.length,
      total_amount: totalAmount,
      vendor_count: vendorCount,
      bulk_action_id: bulkActionId,
      decided_by: actor,
      decided_at: new Date().toISOString(),
      proposed_reason: input.reason ?? null,
    })
  if (propErr) return { ok: false, error: propErr.message }

  // One history row (not tied to any transaction) so the merge shows in
  // "Recent changes" and can be undone through the same path as other actions.
  const auditErr = await insertAuditInChunks(supabase, [
    {
      transaction_id: null,
      field: '_category_merge',
      previous_value: from.join(', '),
      new_value: to,
      action: 'category_merge',
      bulk_action_id: bulkActionId,
      actor_email: actor,
      reason:
        input.reason ??
        `Grouped ${from.length} labels under ${to} for reporting (display only).`,
    },
  ])
  if (auditErr) return { ok: false, error: auditErr }

  revalidateAll()
  return { ok: true, updated: targets.length, bulkActionId }
}

/**
 * Reject a proposed merge so it stops being suggested. No transaction changes —
 * this only records the decision.
 */
export async function rejectMerge(input: {
  fromCategories: string[]
  toCategory: string
}): Promise<ActionResult> {
  const from = (input.fromCategories ?? []).filter((v) => v?.trim())
  const to = (input.toCategory ?? '').trim()
  if (from.length === 0 || !to) return { ok: false, error: 'Nothing to reject.' }

  const supabase = await createClient()
  const actor = await actorEmail(supabase)

  const { error } = await supabase.from('category_merge_proposals').insert({
    from_categories: from,
    to_category: to,
    status: 'rejected',
    decided_by: actor,
    decided_at: new Date().toISOString(),
  })
  if (error) return { ok: false, error: error.message }

  revalidateAll()
  return { ok: true }
}

/**
 * Reclassify mis-typed income rows (e.g. "Sales Deposit" recorded as an
 * expense) to income so they stop inflating spend. Logged for reversal.
 */
export async function reclassifyToIncome(
  transactionIds: string[],
): Promise<ActionResult> {
  const ids = (transactionIds ?? []).filter(Boolean)
  if (ids.length === 0) return { ok: false, error: 'No transactions selected.' }

  const supabase = await createClient()
  const actor = await actorEmail(supabase)
  const bulkActionId = randomUUID()

  const { data: rows, error: fetchErr } = await supabase
    .from('financial_transactions')
    .select('id, transaction_type, review_status')
    .in('id', ids)
  if (fetchErr) return { ok: false, error: fetchErr.message }

  // Log BOTH columns this action writes. The imported `transaction_type` is
  // preserved as `previous_value`, which is what makes the change explainable
  // later and lets Undo restore the row exactly as it was imported.
  const audit = (rows ?? []).flatMap((r) => [
    {
      transaction_id: r.id,
      field: 'transaction_type',
      previous_value: String(r.transaction_type ?? ''),
      new_value: 'income',
      action: 'reclassify_type',
      bulk_action_id: bulkActionId,
      actor_email: actor,
      reason: 'Deposit recorded as an expense; reclassified to income.',
    },
    {
      transaction_id: r.id,
      field: 'review_status',
      previous_value: String(r.review_status ?? ''),
      new_value: 'matched',
      action: 'reclassify_type',
      bulk_action_id: bulkActionId,
      actor_email: actor,
      reason: 'Marked reviewed alongside the type change.',
    },
  ])
  const auditErr = await insertAuditInChunks(supabase, audit)
  if (auditErr) return { ok: false, error: auditErr }

  const updErr = await updateInChunks(supabase, ids, {
    transaction_type: 'income',
    review_status: 'matched',
  })
  if (updErr) return { ok: false, error: updErr }

  revalidateAll()
  return { ok: true, updated: ids.length }
}

/**
 * Assign a spending category to a batch of transactions (used from the CHECK
 * queue once the owner recognises a repeating amount as a known payee). Each
 * change is logged so it can be undone.
 */
export async function categorizeTransactions(input: {
  transactionIds: string[]
  category: string
}): Promise<ActionResult & { bulkActionId?: string }> {
  const ids = (input.transactionIds ?? []).filter(Boolean)
  const category = (input.category ?? '').trim()
  if (ids.length === 0) return { ok: false, error: 'No transactions selected.' }
  if (!category) return { ok: false, error: 'Enter a category.' }

  const supabase = await createClient()
  const actor = await actorEmail(supabase)
  const bulkActionId = randomUUID()

  const { data: rows, error: fetchErr } = await supabase
    .from('financial_transactions')
    .select('id, expense_category, review_status')
    .in('id', ids)
  if (fetchErr) return { ok: false, error: fetchErr.message }

  // Both written columns are logged so Undo restores the row completely.
  const audit = (rows ?? []).flatMap((r) => [
    {
      transaction_id: r.id,
      field: 'expense_category',
      previous_value: String(r.expense_category ?? ''),
      new_value: category,
      action: 'categorize_checks',
      bulk_action_id: bulkActionId,
      actor_email: actor,
      reason: `Assigned "${category}" to ${ids.length} check(s).`,
    },
    {
      transaction_id: r.id,
      field: 'review_status',
      previous_value: String(r.review_status ?? ''),
      new_value: 'matched',
      action: 'categorize_checks',
      bulk_action_id: bulkActionId,
      actor_email: actor,
      reason: 'Marked reviewed alongside the category assignment.',
    },
  ])
  const auditErr = await insertAuditInChunks(supabase, audit)
  if (auditErr) return { ok: false, error: auditErr }

  const updErr = await updateInChunks(supabase, ids, {
    expense_category: category,
    review_status: 'matched',
  })
  if (updErr) return { ok: false, error: updErr }

  revalidateAll()
  return { ok: true, updated: ids.length, bulkActionId }
}

/**
 * Undo a bulk action by restoring each recorded `previous_value`. Works for any
 * logged action (a merge or a reclassification) because the audit row stores
 * exactly which column changed and what it held before.
 */
export async function revertBulkAction(bulkActionId: string): Promise<ActionResult> {
  if (!bulkActionId) return { ok: false, error: 'No action specified.' }

  const supabase = await createClient()

  const { data: entries, error } = await supabase
    .from('transaction_audit_log')
    .select('id, transaction_id, field, previous_value')
    .eq('bulk_action_id', bulkActionId)
    .is('reverted_at', null)
  if (error) return { ok: false, error: error.message }
  if (!entries || entries.length === 0) {
    return { ok: false, error: 'Nothing to undo — already reverted.' }
  }

  // Merge history rows (`_category_merge`) never changed a transaction, so there
  // is nothing to restore — only rows that recorded a real column change and
  // carry a transaction_id get their previous value put back.
  const dataEntries = entries.filter(
    (e) => e.transaction_id && e.field !== '_category_merge',
  )

  // Group by (field, previous_value) so each distinct restore is one update.
  const groups = new Map<string, { field: string; value: string; ids: string[] }>()
  for (const e of dataEntries) {
    const field = String(e.field)
    const value = e.previous_value == null ? '' : String(e.previous_value)
    const key = `${field}::${value}`
    const g = groups.get(key) ?? { field, value, ids: [] }
    g.ids.push(String(e.transaction_id))
    groups.set(key, g)
  }

  for (const g of groups.values()) {
    const patch = { [g.field]: g.value === '' ? null : g.value }
    const updErr = await updateInChunks(supabase, g.ids, patch)
    if (updErr) return { ok: false, error: updErr }
  }

  const now = new Date().toISOString()
  await supabase
    .from('transaction_audit_log')
    .update({ reverted_at: now })
    .eq('bulk_action_id', bulkActionId)
    .is('reverted_at', null)

  // A reverted merge becomes 'undone': its alias stops applying immediately, so
  // reporting returns to the ungrouped view, and it stays visible on the status
  // board (distinct from a deliberate 'rejected') where it can be re-approved.
  await supabase
    .from('category_merge_proposals')
    .update({ status: 'undone', decided_at: now })
    .eq('bulk_action_id', bulkActionId)

  revalidateAll()
  return { ok: true, updated: entries.length }
}
