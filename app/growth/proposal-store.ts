'use server'

/**
 * Persistence for saved growth proposals (M3).
 *
 * Two tables (see migrations): `growth_proposals` holds the typed input + the lens
 * it was saved under; `growth_proposal_analyses` holds IMMUTABLE verdict snapshots.
 *
 * Owner-approved model: the verdict a proposal shows is ALWAYS re-run live against
 * today's cash, so it can never be stale. The original snapshot is kept for a
 * before/after story ("was Not Supported in Aug, now Supported"). To keep that
 * history meaningful rather than noisy:
 *   - reads (`getSavedProposalDetail`, `listSavedProposals`) NEVER write;
 *   - a new analysis row is inserted ONLY on an explicit `recheckProposal`, and
 *     only when the verdict actually moved from the last stored one.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { analyzeProposalFromSnapshot } from '@/lib/growth-planner-service'
import { getSavedProposalReviews } from '@/lib/growth-proposal-review'
import type { Attribution } from '@/lib/growth-outcomes'
import { draftToProposal, num } from '@/app/growth/proposal-draft'
import type { Proposal, ProposalDecision } from '@/lib/growth-proposals'
import type {
  AnalysisSummary,
  ProposalDraft,
  SaveProposalResult,
  SavedProposalDetail,
  SavedProposalSummary,
} from '@/app/growth/proposal-types'

/* -------------------------------- helpers -------------------------------- */

type AnalysisRow = {
  id: string
  proposal_id: string
  mode_key: string
  assumed_margin_pct: number | null
  confidence_pct: number | null
  classification: string
  verdict: string
  lowest_projected_cash: number | null
  lowest_month_key: string | null
  created_at: string
}

function rowToSummary(r: AnalysisRow): AnalysisSummary {
  return {
    id: r.id,
    createdAt: r.created_at,
    modeKey: r.mode_key,
    assumedMarginPct: r.assumed_margin_pct,
    confidencePct: r.confidence_pct,
    classification: r.classification as AnalysisSummary['classification'],
    verdict: r.verdict as AnalysisSummary['verdict'],
    lowestProjectedCash: r.lowest_projected_cash,
    lowestMonthKey: r.lowest_month_key,
  }
}

/** The columns we denormalise from a decision, in one place so save and recheck
 *  can never disagree about what a snapshot row contains. */
function decisionToAnalysisInsert(
  proposalId: string,
  decision: ProposalDecision,
  modeKey: string,
  assumedMarginPct: number | null,
  confidencePct: number,
) {
  return {
    proposal_id: proposalId,
    mode_key: modeKey,
    assumed_margin_pct: assumedMarginPct,
    confidence_pct: confidencePct,
    classification: decision.classification,
    verdict: decision.verdict,
    lowest_projected_cash: decision.lowestProjectedCash,
    lowest_month_key: decision.lowestMonthKey,
    decision: decision as unknown as Record<string, unknown>,
  }
}

/** True when the live verdict differs materially from the last stored one. Used to
 *  decide whether a re-check is worth a new history row. */
function verdictMoved(latest: AnalysisRow | undefined, live: ProposalDecision): boolean {
  if (!latest) return true
  return (
    latest.classification !== live.classification ||
    latest.verdict !== live.verdict
  )
}

/* -------------------------------- actions -------------------------------- */

/** Analyse a draft and persist it plus its first verdict snapshot. */
export async function saveProposal(draft: ProposalDraft): Promise<SaveProposalResult> {
  let proposal: Proposal
  try {
    proposal = draftToProposal(draft)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not read the proposal.' }
  }

  const assumedMarginPct = num(draft.assumedMarginPct)
  const modeKey = draft.modeKey ?? ''

  let decision: ProposalDecision
  let confidencePct: number
  let resolvedModeKey = modeKey
  try {
    const res = await analyzeProposalFromSnapshot(proposal, { modeKey, assumedMarginPct })
    decision = res.decision
    confidencePct = res.confidencePct
    // The service resolves a blank modeKey to the active default; capture what it
    // actually used so a later re-run reproduces the same lens.
    resolvedModeKey = res.resolvedModeKey ?? modeKey
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Analysis failed.' }
  }

  const supabase = await createClient()

  const { data: inserted, error: insErr } = await supabase
    .from('growth_proposals')
    .insert({
      name: proposal.name,
      proposal_type: proposal.type,
      proposal: proposal as unknown as Record<string, unknown>,
      mode_key: resolvedModeKey,
      assumed_margin_pct: assumedMarginPct,
    })
    .select('id')
    .single()

  if (insErr || !inserted) {
    return { ok: false, error: insErr?.message ?? 'Could not save the proposal.' }
  }

  const { error: aErr } = await supabase
    .from('growth_proposal_analyses')
    .insert(decisionToAnalysisInsert(inserted.id, decision, resolvedModeKey, assumedMarginPct, confidencePct))

  if (aErr) {
    // The proposal saved but the first snapshot failed — surface it rather than
    // pretend success, since the before/after story depends on that first row.
    return { ok: false, error: `Saved, but recording the first verdict failed: ${aErr.message}` }
  }

  revalidatePath('/growth')
  return { ok: true, id: inserted.id }
}

/**
 * List saved proposals with their original verdict and a LIVE one.
 *
 * Delegates to the shared `getSavedProposalReviews` loader rather than reading the
 * last stored verdict. That was a real inconsistency: the list showed a stale badge
 * while the detail page re-ran live, so a proposal that had quietly become
 * unaffordable still looked fine until the owner opened it. One loader means the
 * list, the detail page, the dashboard and the advisor cannot disagree.
 */
export async function listSavedProposals(): Promise<SavedProposalSummary[]> {
  const reviews = await getSavedProposalReviews()
  return reviews.map((r) => ({
    id: r.id,
    name: r.name,
    proposalType: r.proposalType as SavedProposalSummary['proposalType'],
    createdAt: r.createdAt,
    modeKey: r.modeKey,
    originalClassification: r.originalClassification,
    liveClassification: r.live.classification,
    changed: r.changed,
    worsened: r.worsened,
    approvedAt: r.approvedAt,
  }))
}

/**
 * Record that an approved commitment actually went live (M5).
 *
 * Upserted on `proposal_id`, so correcting the start date or upfront cost revises
 * the record instead of creating a second conflicting activation.
 */
export async function activateProposal(input: {
  proposalId: string
  actualStartDate: string
  actualUpfrontCost: number
  notes?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.actualStartDate)) {
    return { ok: false, error: 'Enter the start date as a real calendar date.' }
  }
  if (!Number.isFinite(input.actualUpfrontCost) || input.actualUpfrontCost < 0) {
    return { ok: false, error: 'Upfront cost cannot be negative.' }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('growth_proposal_activations').upsert(
    {
      proposal_id: input.proposalId,
      actual_start_date: input.actualStartDate,
      actual_upfront_cost: input.actualUpfrontCost,
      notes: input.notes?.trim() || null,
    },
    { onConflict: 'proposal_id' },
  )
  if (error) return { ok: false, error: error.message }

  revalidateProposalViews(input.proposalId)
  return { ok: true }
}

/**
 * Record what a commitment actually cost and earned in one month.
 *
 * `actualCost` and `revenueImpact` stay null when not supplied — an unrecorded month
 * must never be stored as $0, because that would read as a free month. Revenue is
 * rejected without a defensible attribution rather than silently downgraded, so an
 * unexplained number can never end up presented as a return (the database enforces
 * the same rule, this is the friendly version of that error).
 */
export async function recordProposalOutcome(input: {
  proposalId: string
  monthKey: string
  actualCost: number | null
  revenueImpact: number | null
  attribution: Attribution
  notes?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  if (!/^\d{4}-\d{2}$/.test(input.monthKey)) {
    return { ok: false, error: 'Pick a month.' }
  }
  if (input.actualCost != null && (!Number.isFinite(input.actualCost) || input.actualCost < 0)) {
    return { ok: false, error: 'Actual cost cannot be negative.' }
  }
  if (
    input.revenueImpact != null &&
    (!Number.isFinite(input.revenueImpact) || input.revenueImpact < 0)
  ) {
    return { ok: false, error: 'Added sales cannot be negative.' }
  }
  if (input.revenueImpact != null && input.attribution === 'not_measurable') {
    return {
      ok: false,
      error:
        'You entered added sales but marked them not measurable. Either say how much of it you can attribute to this commitment, or leave the sales figure blank.',
    }
  }
  if (input.actualCost == null && input.revenueImpact == null) {
    return { ok: false, error: 'Enter what it cost, what it earned, or both.' }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('growth_proposal_outcomes').upsert(
    {
      proposal_id: input.proposalId,
      month_key: input.monthKey,
      actual_cost: input.actualCost,
      revenue_impact: input.revenueImpact,
      attribution: input.attribution,
      notes: input.notes?.trim() || null,
    },
    // Re-entering a month CORRECTS it. Without this, logging the same month twice
    // would double-count its revenue.
    { onConflict: 'proposal_id,month_key' },
  )
  if (error) return { ok: false, error: error.message }

  revalidateProposalViews(input.proposalId)
  return { ok: true }
}

/** Remove one month's record, for when it was entered against the wrong month. */
export async function deleteProposalOutcome(
  proposalId: string,
  monthKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('growth_proposal_outcomes')
    .delete()
    .eq('proposal_id', proposalId)
    .eq('month_key', monthKey)
  if (error) return { ok: false, error: error.message }

  revalidateProposalViews(proposalId)
  return { ok: true }
}

/** Every surface that reads a proposal's figures, refreshed together. */
function revalidateProposalViews(proposalId: string) {
  revalidatePath('/')
  revalidatePath('/admin')
  revalidatePath('/ai-advisor')
  revalidatePath('/growth')
  revalidatePath('/growth/proposals')
  revalidatePath(`/growth/proposals/${proposalId}`)
}

/** Mark a proposal as one the owner actually went ahead with, or undo that. Kept
 *  separate from the verdict history: approving is a decision, not an analysis. */
export async function setProposalApproved(
  id: string,
  approved: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('growth_proposals')
    .update({ approved_at: approved ? new Date().toISOString() : null })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/growth')
  revalidatePath('/growth/proposals')
  revalidatePath(`/growth/proposals/${id}`)
  return { ok: true }
}

/** Full detail with a LIVE re-run (never stale) plus original + history. Read-only. */
export async function getSavedProposalDetail(id: string): Promise<SavedProposalDetail | null> {
  const supabase = await createClient()

  const { data: p, error } = await supabase
    .from('growth_proposals')
    .select('id, name, proposal_type, proposal, mode_key, assumed_margin_pct, created_at')
    .eq('id', id)
    .is('deleted_at', null)
    .single()

  if (error || !p) return null

  const proposal = p.proposal as unknown as Proposal
  const assumedMarginPct = p.assumed_margin_pct as number | null

  const { decision, confidencePct, activeModeLabel } = await analyzeProposalFromSnapshot(proposal, {
    modeKey: p.mode_key,
    assumedMarginPct,
  })

  const { data: analyses } = await supabase
    .from('growth_proposal_analyses')
    .select('*')
    .eq('proposal_id', id)
    .order('created_at', { ascending: true })

  const rows = (analyses ?? []) as AnalysisRow[]
  if (rows.length === 0) return null
  const original = rowToSummary(rows[0])
  const history = [...rows].reverse().map(rowToSummary)

  return {
    id: p.id,
    name: p.name,
    proposalType: p.proposal_type as SavedProposalDetail['proposalType'],
    createdAt: p.created_at,
    modeKey: p.mode_key,
    assumedMarginPct,
    current: decision,
    currentModeLabel: activeModeLabel,
    currentConfidencePct: confidencePct,
    original,
    history,
  }
}

/** Explicit re-check: re-run live and, ONLY if the verdict moved, record a new
 *  immutable snapshot so the history reflects real changes rather than page views. */
export async function recheckProposal(
  id: string,
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const supabase = await createClient()

  const { data: p, error } = await supabase
    .from('growth_proposals')
    .select('id, proposal, mode_key, assumed_margin_pct')
    .eq('id', id)
    .is('deleted_at', null)
    .single()

  if (error || !p) return { ok: false, error: 'Proposal not found.' }

  const proposal = p.proposal as unknown as Proposal
  const assumedMarginPct = p.assumed_margin_pct as number | null

  let decision: ProposalDecision
  let confidencePct: number
  try {
    const res = await analyzeProposalFromSnapshot(proposal, {
      modeKey: p.mode_key,
      assumedMarginPct,
    })
    decision = res.decision
    confidencePct = res.confidencePct
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Re-check failed.' }
  }

  const { data: latestArr } = await supabase
    .from('growth_proposal_analyses')
    .select('*')
    .eq('proposal_id', id)
    .order('created_at', { ascending: false })
    .limit(1)

  const latest = (latestArr ?? [])[0] as AnalysisRow | undefined

  if (!verdictMoved(latest, decision)) {
    return { ok: true, changed: false }
  }

  const { error: aErr } = await supabase
    .from('growth_proposal_analyses')
    .insert(decisionToAnalysisInsert(id, decision, p.mode_key, assumedMarginPct, confidencePct))

  if (aErr) return { ok: false, error: aErr.message }

  revalidatePath('/growth')
  revalidatePath(`/growth/proposals/${id}`)
  return { ok: true, changed: true }
}

/** Soft-delete: keep the row (and its history) but hide it from the list. */
export async function deleteProposal(id: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('growth_proposals')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/growth')
  return { ok: true }
}
