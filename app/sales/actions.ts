'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { recalculateSales, syncFinalColumns } from '@/lib/sales-service'
import type { UnclassifiedPayee } from '@/lib/sales-calculator'

const REVALIDATE_PATHS = ['/', '/sales', '/cash-flow', '/ai-advisor', '/admin']

function revalidateAll() {
  for (const p of REVALIDATE_PATHS) revalidatePath(p)
}

async function requireUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  return supabase
}

export type SalesActionResult = {
  ok: boolean
  error?: string
  monthsWritten?: number
  monthsSkippedLocked?: number
  unclassified?: UnclassifiedPayee[]
  excludedTotal?: number
  classifiedTotal?: number
}

/** Rebuild monthly sales from imported financial records. */
export async function recalculateSalesAction(): Promise<SalesActionResult> {
  try {
    await requireUser()
    const result = await recalculateSales()
    revalidateAll()
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed' }
  }
}

/**
 * Record a manual correction for one month.
 *
 * Passing an empty string clears the override, which lets the owner fall back to
 * the calculated figure rather than being stuck with a number they once typed.
 */
export async function setManualSalesAction(input: {
  monthOrder: number
  year: number
  month: string
  manualWholesale: string
  manualRetail: string
}): Promise<SalesActionResult> {
  try {
    const supabase = await requireUser()

    const parse = (v: string) => {
      const trimmed = String(v ?? '').trim()
      if (trimmed === '') return null
      const n = Number(trimmed.replace(/[$,\s]/g, ''))
      if (!Number.isFinite(n) || n < 0) throw new Error('Enter a valid amount.')
      return n
    }

    const patch = {
      manual_wholesale: parse(input.manualWholesale),
      manual_retail: parse(input.manualRetail),
    }

    const { data: existing } = await supabase
      .from('sales_monthly')
      .select('id')
      .eq('month_order', input.monthOrder)
      .eq('year', input.year)
      .maybeSingle()

    if (existing?.id) {
      const { error } = await supabase
        .from('sales_monthly')
        .update(patch)
        .eq('id', existing.id)
      if (error) return { ok: false, error: error.message }
    } else {
      const { error } = await supabase.from('sales_monthly').insert({
        month: input.month,
        month_order: input.monthOrder,
        year: input.year,
        wholesale: patch.manual_wholesale ?? 0,
        retail: patch.manual_retail ?? 0,
        ...patch,
      })
      if (error) return { ok: false, error: error.message }
    }

    await syncFinalColumns()
    revalidateAll()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed' }
  }
}

/** Lock or unlock a month so recalculation cannot restate it. */
export async function setSalesLockAction(
  id: string,
  locked: boolean,
): Promise<SalesActionResult> {
  try {
    const supabase = await requireUser()
    const { error } = await supabase
      .from('sales_monthly')
      .update({ locked })
      .eq('id', id)
    if (error) return { ok: false, error: error.message }
    revalidateAll()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed' }
  }
}

/** Teach the calculator how to treat an unrecognised deposit description. */
export async function addSalesRuleAction(input: {
  matchText: string
  channel: 'retail' | 'wholesale' | 'exclude'
}): Promise<SalesActionResult> {
  try {
    const supabase = await requireUser()
    const phrase = String(input.matchText ?? '').trim().toUpperCase()
    if (phrase.replace(/[^A-Z0-9]/g, '').length < 3) {
      return { ok: false, error: 'Match text is too short to be safe.' }
    }

    const { data: existing } = await supabase
      .from('sales_source_rules')
      .select('id')
      .eq('match_text', phrase)
      .maybeSingle()

    if (!existing) {
      const { error } = await supabase.from('sales_source_rules').insert({
        match_text: phrase,
        match_type: 'contains',
        channel: input.channel,
        priority: 6,
      })
      if (error) return { ok: false, error: error.message }
    }

    const result = await recalculateSales()
    revalidateAll()
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed' }
  }
}
