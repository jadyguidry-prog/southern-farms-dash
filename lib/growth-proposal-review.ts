/**
 * ONE shared review of every saved growth proposal, re-run LIVE against today's cash.
 *
 * Why this module exists at all: the saved-proposal list, the detail page, the
 * dashboard card, the AI Advisor and the admin report all need to answer "does this
 * still fit?". If each computed it separately they would drift, and the drift shows
 * up as two panels disagreeing about the same proposal. Everything calls this.
 *
 * It was also the fix for a real inconsistency: the list originally showed the last
 * STORED verdict while the detail page re-ran live, so a proposal that had quietly
 * become unaffordable still displayed its old badge, and the advisor could not warn
 * about it until the owner manually re-checked. Reading is cheap here because
 * `getGrowthPlannerSnapshot` is `cache`-wrapped — N proposals share one projection.
 *
 * Strictly READ-ONLY: it never inserts a snapshot. Only an explicit re-check writes
 * history, so opening a page can never manufacture a verdict change.
 */

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { analyzeProposalFromSnapshot } from '@/lib/growth-planner-service'
import { CLASSIFICATION_ORDER, type Classification } from '@/lib/growth-planner'
import type { Proposal, ProposalDecision } from '@/lib/growth-proposals'

export type ProposalReview = {
  id: string
  name: string
  proposalType: string
  createdAt: string
  modeKey: string
  assumedMarginPct: number | null
  approvedAt: string | null
  /** The frozen first verdict, for the before/after story. */
  originalClassification: Classification
  originalCreatedAt: string
  /** Verdict recomputed against today's numbers — the one to act on. */
  live: ProposalDecision
  liveModeLabel: string
  liveConfidencePct: number
  /** True when the live classification differs from the original. */
  changed: boolean
  /** True when it changed for the WORSE (was more affordable when saved). */
  worsened: boolean
}

/** Position of a classification on the worst → best scale, for comparisons. */
function rank(c: Classification): number {
  const i = CLASSIFICATION_ORDER.indexOf(c)
  // An unknown value must not silently sort as "worst" and trigger a false alarm.
  return i < 0 ? CLASSIFICATION_ORDER.length : i
}

/**
 * Every active saved proposal, re-run live. Newest first.
 *
 * A proposal with no stored analysis row is skipped rather than shown, because the
 * before/after comparison it exists for would have nothing to compare against.
 */
export const getSavedProposalReviews = cache(async (): Promise<ProposalReview[]> => {
  const supabase = await createClient()

  const { data: proposals, error } = await supabase
    .from('growth_proposals')
    .select(
      'id, name, proposal_type, proposal, mode_key, assumed_margin_pct, approved_at, created_at',
    )
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (error || !proposals || proposals.length === 0) return []

  // First (oldest) stored analysis per proposal = the original verdict.
  const { data: analyses } = await supabase
    .from('growth_proposal_analyses')
    .select('proposal_id, classification, created_at')
    .in(
      'proposal_id',
      proposals.map((p) => p.id),
    )
    .order('created_at', { ascending: true })

  const firstByProposal = new Map<string, { classification: string; created_at: string }>()
  for (const a of analyses ?? []) {
    if (!firstByProposal.has(a.proposal_id)) {
      firstByProposal.set(a.proposal_id, {
        classification: a.classification,
        created_at: a.created_at,
      })
    }
  }

  const out: ProposalReview[] = []
  for (const p of proposals) {
    const first = firstByProposal.get(p.id)
    if (!first) continue

    const proposal = p.proposal as unknown as Proposal
    const assumedMarginPct = (p.assumed_margin_pct as number | null) ?? null

    let res: Awaited<ReturnType<typeof analyzeProposalFromSnapshot>>
    try {
      res = await analyzeProposalFromSnapshot(proposal, {
        modeKey: p.mode_key,
        assumedMarginPct,
      })
    } catch {
      // A single malformed saved proposal must not blank the dashboard or the
      // advisor for everything else, so skip it rather than throw.
      continue
    }

    const originalClassification = first.classification as Classification
    const liveClassification = res.decision.classification
    const changed = originalClassification !== liveClassification

    out.push({
      id: p.id,
      name: p.name,
      proposalType: p.proposal_type,
      createdAt: p.created_at,
      modeKey: p.mode_key,
      assumedMarginPct,
      approvedAt: (p.approved_at as string | null) ?? null,
      originalClassification,
      originalCreatedAt: first.created_at,
      live: res.decision,
      liveModeLabel: res.activeModeLabel,
      liveConfidencePct: res.confidencePct,
      changed,
      worsened: changed && rank(liveClassification) < rank(originalClassification),
    })
  }

  return out
})
