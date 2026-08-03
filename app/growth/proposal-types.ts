/**
 * Shared, dependency-free types for the proposal analyzer's client/server
 * boundary.
 *
 * These live in their own module ON PURPOSE. The client form and the server
 * action both need them, but a `'use server'` file may only export async
 * functions — exporting a type from it drags the entire server module (and its
 * `next/headers` dependency) into the client bundle, which breaks the build. A
 * pure types file lets both sides share the contract with nothing to bundle.
 */

import type { Classification } from '@/lib/growth-planner'
import type { ProposalDecision, ProposalType, Verdict } from '@/lib/growth-proposals'

export type ProposalDraft = {
  type: ProposalType
  name: string
  modeKey?: string
  /** Owner-entered gross margin, optional and labelled an assumption downstream. */
  assumedMarginPct?: string
  fields: Record<string, string>
}

export type AnalysisResult =
  | { ok: true; decision: ProposalDecision; modeLabel: string; confidencePct: number }
  | { ok: false; error: string }

/* --------------------- Saved proposals (M3) --------------------- */

/** One immutable analysis snapshot, flattened for lists and the before/after view. */
export type AnalysisSummary = {
  id: string
  createdAt: string
  modeKey: string
  assumedMarginPct: number | null
  confidencePct: number | null
  classification: Classification
  verdict: Verdict
  lowestProjectedCash: number | null
  lowestMonthKey: string | null
}

/** A saved proposal as shown in the list. `liveClassification` is recomputed against
 *  today's cash — NOT the last stored verdict — so the list, the detail page, the
 *  dashboard and the advisor all say the same thing about the same proposal. */
export type SavedProposalSummary = {
  id: string
  name: string
  proposalType: ProposalType
  createdAt: string
  modeKey: string
  originalClassification: Classification
  liveClassification: Classification
  /** Live verdict differs from the one recorded when it was saved. */
  changed: boolean
  /** The change is for the worse. */
  worsened: boolean
  approvedAt: string | null
}

/** Full detail: the live re-run decision (never stale), the original snapshot for
 *  comparison, and the complete history of verdict changes. */
export type SavedProposalDetail = {
  id: string
  name: string
  proposalType: ProposalType
  createdAt: string
  modeKey: string
  assumedMarginPct: number | null
  /** Re-run against TODAY's cash — this is what the owner acts on. */
  current: ProposalDecision
  currentModeLabel: string
  currentConfidencePct: number
  /** The very first analysis, frozen, for the before/after story. */
  original: AnalysisSummary
  /** Every stored analysis, newest first (each a real change in verdict). */
  history: AnalysisSummary[]
}

export type SaveProposalResult =
  | { ok: true; id: string }
  | { ok: false; error: string }
