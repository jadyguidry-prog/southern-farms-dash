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

/** List saved proposals with their first and most-recently-STORED verdicts.
 *  Read-only: it shows "last checked" figures and never re-runs (that would make
 *  the list arbitrarily expensive); the detail view is where the live re-run lives. */
export async function listSavedProposals(): Promise<SavedProposalSummary[]> {
  const supabase = await createClient()

  const { data: proposals, error } = await supabase
    .from('growth_proposals')
    .select('id, name, proposal_type, mode_key, created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (error || !proposals || proposals.length === 0) return []

  const ids = proposals.map((p) => p.id)
  const { data: analyses } = await supabase
    .from('growth_proposal_analyses')
    .select('*')
    .in('proposal_id', ids)
    .order('created_at', { ascending: true })

  const byProposal = new Map<string, AnalysisRow[]>()
  for (const a of (analyses ?? []) as AnalysisRow[]) {
    const list = byProposal.get(a.proposal_id) ?? []
    list.push(a)
    byProposal.set(a.proposal_id, list)
  }

  const out: SavedProposalSummary[] = []
  for (const p of proposals) {
    const list = byProposal.get(p.id)
    if (!list || list.length === 0) continue // a proposal with no snapshot is unusable
    const original = list[0]
    const current = list[list.length - 1]
    out.push({
      id: p.id,
      name: p.name,
      proposalType: p.proposal_type as SavedProposalSummary['proposalType'],
      createdAt: p.created_at,
      modeKey: p.mode_key,
      original: rowToSummary(original),
      current: rowToSummary(current),
      changed: original.classification !== current.classification,
    })
  }
  return out
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
