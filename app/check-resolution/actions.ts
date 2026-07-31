'use server'

// Writes for the CHECK Resolution screen.
//
// The invariant that matters most: these actions write ONLY to
// `check_resolutions` and `check_resolution_audit`. They never touch
// `financial_transactions` — not `expense_category`, not `vendor_id`, not
// `review_status`. The bank export stays exactly as the bank sent it, so every
// resolution is reversible and no derived answer can ever be mistaken for source
// data.
//
// Every write records enough of the previous state in the audit table to restore
// it exactly, including "there was no row here before".

import { revalidatePath } from 'next/cache'
import { randomUUID } from 'node:crypto'
import { createClient } from '@/lib/supabase/server'

type ActionResult = {
  ok: boolean
  error?: string
  updated?: number
  bulkActionId?: string
}

const OVERLAY_COLUMNS =
  'id, financial_transaction_id, check_number, resolved_payee, resolved_vendor_id, resolved_category, memo, business_purpose, review_status, confidence, resolution_source, reviewed_by, reviewed_at, bulk_action_id'

/** Paths that read the overlay and must refresh after any write. */
const AFFECTED_PATHS = [
  '/check-resolution',
  '/category-review',
  '/',
  '/admin',
  '/ai-advisor',
  '/sales',
]

function revalidateAll() {
  for (const p of AFFECTED_PATHS) revalidatePath(p)
}

async function currentActor(): Promise<string | null> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  return data.user?.email ?? null
}

export type ResolveCheckInput = {
  transactionIds: string[]
  payee: string
  category: string
  memo?: string
  businessPurpose?: string
  /** Which suggestion drove this, for the audit trail. Free text is fine. */
  source?: string
  confidence?: 'high' | 'medium' | 'low'
}

/**
 * Record an owner-approved resolution for one or more checks.
 *
 * Runs as a single bulk action so the whole group can be undone together — a
 * 18-check cluster approved by mistake should take one click to reverse, not 18.
 */
export async function resolveChecks(input: ResolveCheckInput): Promise<ActionResult> {
  const ids = [...new Set((input.transactionIds ?? []).filter(Boolean))]
  const payee = (input.payee ?? '').trim()
  const category = (input.category ?? '').trim()

  // Validate before writing. A blank payee is the whole reason these checks are
  // unresolved, so saving one would record a non-answer as an answer.
  if (ids.length === 0) return { ok: false, error: 'No checks were selected.' }
  if (!payee) return { ok: false, error: 'Enter who this check was paid to.' }
  if (!category) return { ok: false, error: 'Choose a category for this spend.' }

  const supabase = await createClient()
  const actor = await currentActor()
  const bulkActionId = randomUUID()
  const now = new Date().toISOString()

  // Confirm the ids really are live transactions before writing an overlay that
  // points at them. Also pulls check_number so the overlay is readable alone.
  const { data: txns, error: txnError } = await supabase
    .from('financial_transactions')
    .select('id, check_number, description')
    .in('id', ids)
    .is('deleted_at', null)
  if (txnError) return { ok: false, error: txnError.message }
  const live = new Map((txns ?? []).map((t) => [t.id as string, t]))
  const missing = ids.filter((id) => !live.has(id))
  if (missing.length > 0) {
    return {
      ok: false,
      error: `${missing.length} of the selected checks are no longer available. Refresh and try again.`,
    }
  }

  // Snapshot any existing overlay rows so undo can restore them precisely.
  const { data: existing, error: existingError } = await supabase
    .from('check_resolutions')
    .select(OVERLAY_COLUMNS)
    .in('financial_transaction_id', ids)
  if (existingError) return { ok: false, error: existingError.message }
  const previous = new Map(
    (existing ?? []).map((r) => [r.financial_transaction_id as string, r]),
  )

  const rows = ids.map((id) => ({
    financial_transaction_id: id,
    check_number: (live.get(id)?.check_number as string | null) ?? null,
    resolved_payee: payee,
    resolved_category: category,
    memo: (input.memo ?? '').trim() || null,
    business_purpose: (input.businessPurpose ?? '').trim() || null,
    review_status: 'approved',
    confidence: input.confidence ?? null,
    resolution_source: (input.source ?? '').trim() || 'manual',
    reviewed_by: actor,
    reviewed_at: now,
    bulk_action_id: bulkActionId,
    updated_at: now,
  }))

  // Upsert on the transaction id: re-resolving a check should correct the
  // existing answer rather than stack a second conflicting one.
  const { error: upsertError } = await supabase
    .from('check_resolutions')
    .upsert(rows, { onConflict: 'financial_transaction_id' })
  if (upsertError) return { ok: false, error: upsertError.message }

  const auditRows = ids.map((id) => ({
    bulk_action_id: bulkActionId,
    financial_transaction_id: id,
    action: previous.has(id) ? 'update' : 'create',
    previous_overlay: previous.get(id) ?? null,
    new_overlay: rows.find((r) => r.financial_transaction_id === id) ?? null,
    actor_email: actor,
    reason: `Resolved to ${payee} / ${category}`,
  }))
  const { error: auditError } = await supabase
    .from('check_resolution_audit')
    .insert(auditRows)
  // An audit failure is not fatal to the resolution itself, but the owner must
  // know undo may not be available for this batch.
  if (auditError) {
    revalidateAll()
    return {
      ok: true,
      updated: ids.length,
      bulkActionId,
      error: `Saved, but the undo record failed: ${auditError.message}`,
    }
  }

  revalidateAll()
  return { ok: true, updated: ids.length, bulkActionId }
}

/**
 * Mark checks as reviewed-but-not-COGS without naming a payee.
 *
 * Needed because "I looked at this and it is not supplier spend" is a real
 * answer that removes the check from the gross-profit unknown, and forcing a
 * payee would push the owner to invent one.
 */
export async function rejectChecks(
  transactionIds: string[],
  reason?: string,
): Promise<ActionResult> {
  const ids = [...new Set((transactionIds ?? []).filter(Boolean))]
  if (ids.length === 0) return { ok: false, error: 'No checks were selected.' }

  const supabase = await createClient()
  const actor = await currentActor()
  const bulkActionId = randomUUID()
  const now = new Date().toISOString()

  const { data: existing, error: existingError } = await supabase
    .from('check_resolutions')
    .select(OVERLAY_COLUMNS)
    .in('financial_transaction_id', ids)
  if (existingError) return { ok: false, error: existingError.message }
  const previous = new Map(
    (existing ?? []).map((r) => [r.financial_transaction_id as string, r]),
  )

  const rows = ids.map((id) => ({
    financial_transaction_id: id,
    review_status: 'rejected',
    memo: (reason ?? '').trim() || null,
    reviewed_by: actor,
    reviewed_at: now,
    bulk_action_id: bulkActionId,
    updated_at: now,
  }))

  const { error } = await supabase
    .from('check_resolutions')
    .upsert(rows, { onConflict: 'financial_transaction_id' })
  if (error) return { ok: false, error: error.message }

  await supabase.from('check_resolution_audit').insert(
    ids.map((id) => ({
      bulk_action_id: bulkActionId,
      financial_transaction_id: id,
      action: previous.has(id) ? 'update' : 'create',
      previous_overlay: previous.get(id) ?? null,
      new_overlay: rows.find((r) => r.financial_transaction_id === id) ?? null,
      actor_email: actor,
      reason: (reason ?? '').trim() || 'Marked as not cost of goods',
    })),
  )

  revalidateAll()
  return { ok: true, updated: ids.length, bulkActionId }
}

/**
 * Undo a bulk action, restoring the exact previous overlay state.
 *
 * Restores rather than blanket-deletes: if a check already had a resolution that
 * this action overwrote, undo must put the ORIGINAL answer back, not erase both.
 */
export async function undoBulkAction(bulkActionId: string): Promise<ActionResult> {
  if (!bulkActionId) return { ok: false, error: 'No action was specified.' }

  const supabase = await createClient()
  const actor = await currentActor()

  const { data: auditRows, error: auditError } = await supabase
    .from('check_resolution_audit')
    .select('id, financial_transaction_id, action, previous_overlay')
    .eq('bulk_action_id', bulkActionId)
    .is('reverted_at', null)
  if (auditError) return { ok: false, error: auditError.message }
  if (!auditRows || auditRows.length === 0) {
    return { ok: false, error: 'That action has already been undone.' }
  }

  // Rows that did not exist before are removed; rows that did are written back
  // verbatim from the snapshot.
  const toDelete = auditRows
    .filter((r) => r.action === 'create')
    .map((r) => r.financial_transaction_id as string)
  const toRestore = auditRows
    .filter((r) => r.action !== 'create' && r.previous_overlay)
    .map((r) => r.previous_overlay as Record<string, unknown>)

  if (toDelete.length > 0) {
    const { error } = await supabase
      .from('check_resolutions')
      .delete()
      .in('financial_transaction_id', toDelete)
    if (error) return { ok: false, error: error.message }
  }

  if (toRestore.length > 0) {
    const { error } = await supabase
      .from('check_resolutions')
      .upsert(toRestore, { onConflict: 'financial_transaction_id' })
    if (error) return { ok: false, error: error.message }
  }

  const revertedAt = new Date().toISOString()
  await supabase
    .from('check_resolution_audit')
    .update({ reverted_at: revertedAt })
    .eq('bulk_action_id', bulkActionId)
    .is('reverted_at', null)

  // The undo itself is auditable — a reversal is a decision too.
  await supabase.from('check_resolution_audit').insert({
    bulk_action_id: randomUUID(),
    financial_transaction_id: null,
    action: 'undo',
    previous_overlay: null,
    new_overlay: { undid_bulk_action_id: bulkActionId, rows: auditRows.length },
    actor_email: actor,
    reason: `Undid bulk action ${bulkActionId}`,
  })

  revalidateAll()
  return { ok: true, updated: auditRows.length }
}
