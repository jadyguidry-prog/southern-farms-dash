'use server'

import { revalidatePath } from 'next/cache'
import { testSquareConnection, getSquareConfigState } from '@/lib/square-client'
import { runFullSync, rebuildRollups } from '@/lib/square-sync'

export type ActionResult = {
  ok: boolean
  message: string
  detail?: string[]
}

/**
 * Verifies the token actually works before the owner tries a sync, so a bad
 * credential produces one clear message instead of a confusing partial import.
 */
export async function testConnectionAction(): Promise<ActionResult> {
  const config = getSquareConfigState()
  if (!config.configured) {
    return { ok: false, message: config.reason }
  }

  const result = await testSquareConnection()
  if (!result.ok) {
    return { ok: false, message: result.error }
  }

  return {
    ok: true,
    message: `Connected to Square (${result.environment}) — ${result.locations.length} location${
      result.locations.length === 1 ? '' : 's'
    } found.`,
    detail: result.locations.map((l) =>
      [l.name, l.currency, l.timezone].filter(Boolean).join(' · '),
    ),
  }
}

/**
 * Pulls everything new since the last successful sync. Safe to press twice:
 * every write is an upsert keyed on Square's own IDs.
 */
export async function syncNowAction(formData?: FormData): Promise<ActionResult> {
  const full = formData?.get('mode') === 'full'

  const result = await runFullSync({ full })

  const detail = result.outcomes.map((o) =>
    o.ok
      ? `${o.resource}: ${o.recordsSynced} record${o.recordsSynced === 1 ? '' : 's'}`
      : `${o.resource}: failed — ${o.error ?? 'unknown error'}`,
  )

  revalidatePath('/settings')
  revalidatePath('/sales')
  revalidatePath('/')

  if (!result.ok) {
    return {
      ok: false,
      message: result.error ?? 'Sync failed. See the per-step detail below.',
      detail,
    }
  }

  return {
    ok: true,
    message:
      result.ordersSynced === 0
        ? 'Sync completed — no new Square orders in this window.'
        : `Synced ${result.ordersSynced} order${
            result.ordersSynced === 1 ? '' : 's'
          } across ${result.daysAffected} day${result.daysAffected === 1 ? '' : 's'}.`,
    detail,
  }
}

/**
 * Recomputes the daily/monthly rollups from already-synced Square rows without
 * calling the API. Useful if a rollup looks wrong but the raw data is fine.
 */
export async function rebuildRollupAction(): Promise<ActionResult> {
  // No `affectedDates` means "every stored order", i.e. a full rebuild. Refunds
  // and fees are read back from the database, so no API call is needed.
  const result = await rebuildRollups({})

  revalidatePath('/settings')
  revalidatePath('/sales')
  revalidatePath('/')

  return {
    ok: result.ok,
    message: result.ok
      ? `Rebuilt rollups from ${result.recordsSynced} stored Square day${
          result.recordsSynced === 1 ? '' : 's'
        }.`
      : result.error ?? 'Rebuild failed.',
  }
}
