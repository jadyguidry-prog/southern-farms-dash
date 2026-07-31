'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getSalesSourceAudit } from '@/lib/sales-source-audit-service'
import { monthKey } from '@/lib/sales-source-audit'
import { syncFinalColumns } from '@/lib/sales-service'

type ActionResult = {
  ok: boolean
  error?: string
  applied?: number
  netChange?: number
}

function revalidateAll() {
  revalidatePath('/sales')
  revalidatePath('/reports')
  revalidatePath('/ai-advisor')
  revalidatePath('/')
}

/**
 * Correct the reported retail figure for specific months to Square's own record.
 *
 * Only the months named in `monthKeys` are touched. Nothing is inferred from the
 * audit alone: the audit says what *could* be corrected, the owner says what
 * *is*. Three of the nine flagged months move revenue *down*, so applying the
 * whole set unasked would be a silent restatement in both directions.
 *
 * The audit is recomputed here from the database rather than trusted from the
 * client. A stale or tampered figure posted from the browser would otherwise be
 * written straight into the books.
 */
export async function applySquareSourceCorrections(input: {
  monthKeys: string[]
}): Promise<ActionResult> {
  const requested = new Set((input.monthKeys ?? []).filter(Boolean))
  if (requested.size === 0) {
    return { ok: false, error: 'Select at least one month to correct.' }
  }

  const supabase = await createClient()
  const { data: userData } = await supabase.auth.getUser()
  const actor = userData.user?.email ?? null
  if (!actor) return { ok: false, error: 'You must be signed in to apply corrections.' }

  // Recompute server-side. This is the authority for what each month should be.
  const audit = await getSalesSourceAudit()
  const correctable = new Map(audit.downgrades.map((d) => [d.month, d]))

  // A month the audit does not consider correctable is rejected rather than
  // skipped quietly, so a stale page cannot appear to succeed.
  const unknown = [...requested].filter((m) => !correctable.has(m))
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `These months are no longer correctable (the data may have changed since this page loaded): ${unknown.join(', ')}. Reload and try again.`,
    }
  }

  const { data: monthRows, error: readError } = await supabase
    .from('sales_monthly')
    .select('id, year, month, retail, wholesale, source, locked')
  if (readError) return { ok: false, error: readError.message }

  let applied = 0
  let netChange = 0

  for (const row of monthRows ?? []) {
    const mk = monthKey(Number(row.year), String(row.month ?? ''))
    if (!mk || !requested.has(mk)) continue

    // Locked months are closed books. The audit already excludes them, but this
    // is the layer that actually writes, so it re-checks rather than assuming.
    if (row.locked) continue

    const finding = correctable.get(mk)
    if (!finding || finding.squareDailyRetail == null) continue

    const previousRetail = row.retail == null ? null : Number(row.retail)

    // Write Square's figure into its own column and mark the source. Storing it
    // in `square_retail` (rather than overwriting `calculated_retail`) preserves
    // what the bank estimate said, so the correction stays auditable and
    // reversible.
    //
    // `source` is deliberately not set here. `syncFinalColumns` derives it from
    // which tier won each channel, and it is the single authority for that field.
    // Writing 'square' here would be immediately corrected to 'mixed' anyway,
    // because retail now comes from the till while wholesale is still a bank
    // estimate — and 'mixed' is the truthful label for that month.
    const { error: updateError } = await supabase
      .from('sales_monthly')
      .update({
        square_retail: finding.squareDailyRetail,
        retail: finding.squareDailyRetail,
      })
      .eq('id', row.id)

    if (updateError) return { ok: false, error: updateError.message }

    await supabase.from('sales_source_corrections').insert({
      sales_monthly_id: row.id,
      month_key: mk,
      previous_retail: previousRetail,
      previous_source: row.source == null ? null : String(row.source),
      new_retail: finding.squareDailyRetail,
      // What the retail figure itself now comes from. The month's overall
      // `source` may read 'mixed' because wholesale is still a bank estimate,
      // but the number this row is about came from the till.
      new_source: 'square',
      difference: finding.difference,
      actor_email: actor,
      reason: finding.explanation,
    })

    applied += 1
    netChange += finding.difference
  }

  if (applied === 0) {
    return { ok: false, error: 'No months were changed. They may be locked.' }
  }

  // Keep the reported columns consistent with the resolver, which now ranks
  // Square above the bank estimate so this correction is not undone.
  await syncFinalColumns()
  revalidateAll()

  return {
    ok: true,
    applied,
    netChange: Number(netChange.toFixed(2)),
  }
}
