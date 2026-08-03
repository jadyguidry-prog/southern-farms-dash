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

import type { ProposalDecision, ProposalType } from '@/lib/growth-proposals'

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
