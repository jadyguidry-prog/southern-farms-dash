'use server'

/**
 * Server action for the proposal analyzer.
 *
 * The client sends a plain, string-ish draft (form fields are strings). This
 * action is the ONLY place that draft is coerced into a typed `Proposal` and
 * validated, so the pure engine never receives a NaN or a negative cost. All the
 * money math still happens in `analyzeProposalFromSnapshot` against the same
 * snapshot the ladder uses — this file only translates and guards input.
 */

import { analyzeProposalFromSnapshot } from '@/lib/growth-planner-service'
import {
  type EquipmentFinancing,
  type Proposal,
  type ProposalType,
} from '@/lib/growth-proposals'
import type { AnalysisResult, ProposalDraft } from '@/app/growth/proposal-types'

/** Parse a form string into a non-negative number, or null when blank/invalid. */
function num(raw: string | undefined): number | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

export async function runProposalAnalysis(draft: ProposalDraft): Promise<AnalysisResult> {
  const name = draft.name.trim() || defaultName(draft.type)
  const f = draft.fields

  let proposal: Proposal
  try {
    proposal = buildProposal(draft.type, name, f)
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

function defaultName(type: ProposalType): string {
  switch (type) {
    case 'marketing_agency':
      return 'Marketing agency'
    case 'marketing_campaign':
      return 'Marketing campaign'
    case 'equipment':
      return 'Equipment purchase'
    case 'employee_hire':
      return 'New hire'
    case 'inventory':
      return 'Inventory purchase'
  }
}

function required(value: number | null, label: string): number {
  if (value == null) throw new Error(`Enter a value for ${label}.`)
  return value
}

function buildProposal(type: ProposalType, name: string, f: Record<string, string>): Proposal {
  switch (type) {
    case 'marketing_agency':
      return {
        type,
        name,
        monthlyRetainer: required(num(f.monthlyRetainer), 'the monthly retainer'),
        setupFee: num(f.setupFee) ?? undefined,
      }
    case 'marketing_campaign':
      return {
        type,
        name,
        monthlyAmount: required(num(f.monthlyAmount), 'the monthly ad spend'),
        durationMonths: num(f.durationMonths) ?? undefined,
      }
    case 'equipment': {
      const financing = (f.financing as EquipmentFinancing) || 'cash'
      return {
        type,
        name,
        price: required(num(f.price), 'the purchase price'),
        financing,
        downPayment: num(f.downPayment) ?? undefined,
        monthlyPayment: num(f.monthlyPayment) ?? undefined,
        termMonths: num(f.termMonths) ?? undefined,
        balloonPayment: num(f.balloonPayment) ?? undefined,
      }
    }
    case 'employee_hire': {
      const annualSalary = num(f.annualSalary)
      const hourlyWage = num(f.hourlyWage)
      if (annualSalary == null && hourlyWage == null) {
        throw new Error('Enter either an hourly wage or an annual salary.')
      }
      return {
        type,
        name,
        hourlyWage: hourlyWage ?? undefined,
        hoursPerWeek: num(f.hoursPerWeek) ?? undefined,
        annualSalary: annualSalary ?? undefined,
        employerBurdenPct: required(num(f.employerBurdenPct), 'the employer burden percent'),
        oneTimeSetup: num(f.oneTimeSetup) ?? undefined,
      }
    }
    case 'inventory':
      return {
        type,
        name,
        amount: required(num(f.amount), 'the purchase amount'),
      }
  }
}
