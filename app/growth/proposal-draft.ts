/**
 * Pure draft -> typed Proposal conversion and input guards.
 *
 * Deliberately NOT a `'use server'` file: it exports SYNC helpers, and a
 * `'use server'` module may only export async functions. Both the analyze action
 * (`actions.ts`) and the save action (`proposal-store.ts`) import from here so the
 * string-form-field -> typed-Proposal translation and validation live in exactly
 * one place — a second copy would be the "verification drifts from the page" trap
 * all over again, this time between analyze and save.
 */

import {
  type EquipmentFinancing,
  type Proposal,
  type ProposalType,
} from '@/lib/growth-proposals'
import type { ProposalDraft } from '@/app/growth/proposal-types'

/** Parse a form string into a non-negative number, or null when blank/invalid. */
export function num(raw: string | undefined): number | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

function required(value: number | null, label: string): number {
  if (value == null) throw new Error(`Enter a value for ${label}.`)
  return value
}

export function defaultName(type: ProposalType): string {
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

/** Coerce a validated draft into a typed Proposal, throwing a plain-English error
 *  for the first missing/invalid required field. */
export function draftToProposal(draft: ProposalDraft): Proposal {
  const name = draft.name.trim() || defaultName(draft.type)
  const f = draft.fields
  const type = draft.type

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
