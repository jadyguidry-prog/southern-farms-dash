'use server'

/**
 * Server action for the proposal analyzer.
 *
 * The client sends a plain, string-ish draft (form fields are strings). This
 * action guards + coerces it into a typed `Proposal` via the shared
 * `draftToProposal` (the ONE place that translation lives — see proposal-draft.ts),
 * then runs the money math in `analyzeProposalFromSnapshot` against the same
 * snapshot the ladder uses. This file only orchestrates.
 */

import { analyzeProposalFromSnapshot } from '@/lib/growth-planner-service'
import { draftToProposal, num } from '@/app/growth/proposal-draft'
import type { AnalysisResult, ProposalDraft } from '@/app/growth/proposal-types'

export async function runProposalAnalysis(draft: ProposalDraft): Promise<AnalysisResult> {
  let proposal
  try {
    proposal = draftToProposal(draft)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not read the proposal.' }
  }

  const assumedMarginPct = num(draft.assumedMarginPct)

  try {
    const { decision, confidencePct, activeModeLabel } = await analyzeProposalFromSnapshot(proposal, {
      modeKey: draft.modeKey,
      assumedMarginPct,
    })
    return { ok: true, decision, modeLabel: activeModeLabel, confidencePct }
  } catch (e) {
    // Surface the real reason (e.g. a missing setting) rather than a blank failure —
    // the planner is designed to refuse rather than guess, and the owner needs to
    // know which figure is missing.
    return { ok: false, error: e instanceof Error ? e.message : 'Analysis failed.' }
  }
}
