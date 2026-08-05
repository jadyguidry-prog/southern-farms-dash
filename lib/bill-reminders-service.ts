/**
 * Impure edge for bill reminders: reads obligations, payments and settings, then hands
 * everything to the pure engine in `bill-reminders.ts`.
 *
 * `cache()`-wrapped so every surface in one request (dashboard card, cash flow page,
 * advisor) reads the SAME answer. Two panels computing this independently is how they
 * quietly start disagreeing.
 */

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getCashObligations, getBusinessSettings } from '@/lib/queries'
import { resolveNextDueDate, addInterval } from '@/lib/health'
import {
  buildBillReminders,
  type BillReminderInput,
  type BillReminderResult,
  type UnclearedCheckInput,
} from '@/lib/bill-reminders'

/**
 * Read a setting that must exist. Never `?? 0`.
 *
 * A defaulted threshold is worse than a crash here: a silent 0 lead time would mean bills
 * only ever appear on the day they are due, which looks like a working feature while
 * quietly removing all the warning.
 */
function requireSetting(
  settings: Awaited<ReturnType<typeof getBusinessSettings>>,
  key: string,
): number {
  const row = settings.rows.find((r) => r.key === key)
  if (!row || !Number.isFinite(row.value)) {
    throw new Error(
      `business_settings.${key} is missing or not a number. Bill reminders will not substitute a guess.`,
    )
  }
  return row.value
}

/** A Date -> "YYYY-MM-DD" from LOCAL fields, so no timezone can shift the day. */
function toLocalISO(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * Start of the cycle that ends at `dueDate`: one interval back.
 *
 * A payment must fall inside THIS window to settle THIS cycle. Without the window, last
 * month's check would silence this month's reminder and a genuinely unpaid bill would
 * disappear. Null for a one-off, which has no cycle.
 */
function cycleStartFor(
  dueDate: string,
  recurring: boolean,
  frequency: string,
): string | null {
  if (!recurring || !dueDate) return null
  const due = new Date(dueDate + 'T00:00:00')
  // Step forward one interval from a point one interval back is not reversible for
  // month-length reasons, so derive the previous occurrence by subtracting the same
  // interval length that `addInterval` would add.
  const next = addInterval(new Date(due), frequency || 'Monthly')
  const spanDays = Math.round((next.getTime() - due.getTime()) / 86_400_000)
  const start = new Date(due)
  start.setDate(start.getDate() - spanDays)
  return toLocalISO(start)
}

export const getBillReminders = cache(async (): Promise<BillReminderResult> => {
  const supabase = await createClient()
  const [obligations, settings, paymentRows] = await Promise.all([
    getCashObligations(),
    getBusinessSettings(),
    supabase
      .from('obligation_payments')
      .select('obligation_id, payment_date, amount, status, check_number, payee_name')
      .neq('status', 'void'),
  ])

  // requireSetting, never `?? 0`: a failed settings read must fail loudly rather than
  // silently become a plausible-looking wrong threshold.
  const leadDays = requireSetting(settings, 'bill_reminder_lead_days')
  const staleCheckAfterDays = requireSetting(settings, 'card_statement_cycle_stale_days')

  // Read the clock exactly once and pass it down.
  const now = new Date()
  const today = toLocalISO(now)

  const payments = paymentRows.data ?? []

  // Most recent payment per obligation, used to suppress already-handled bills.
  const lastPaymentByObligation = new Map<string, string>()
  for (const p of payments) {
    if (!p.obligation_id || !p.payment_date) continue
    const seen = lastPaymentByObligation.get(p.obligation_id)
    if (!seen || p.payment_date > seen) {
      lastPaymentByObligation.set(p.obligation_id, p.payment_date)
    }
  }

  const bills: BillReminderInput[] = obligations
    .filter((o) => o.active !== false && o.amount > 0)
    .map((o) => {
      const dueDate = resolveNextDueDate(o, now)
      return {
        id: o.id,
        label: o.vendorName || o.obligationName || 'Unnamed bill',
        amount: o.amount,
        dueDate,
        selfScheduled: o.selfScheduled,
        lastPaymentDate: lastPaymentByObligation.get(o.id) ?? null,
        cycleStart: cycleStartFor(dueDate, o.recurring, o.frequency),
      }
    })

  const unclearedChecks: UnclearedCheckInput[] = payments
    .filter((p) => p.status === 'outstanding' && Number(p.amount) > 0 && p.payment_date)
    .map((p) => ({
      checkNumber: p.check_number ?? null,
      payee: p.payee_name ?? null,
      amount: Number(p.amount),
      paymentDate: p.payment_date as string,
    }))

  return buildBillReminders({
    bills,
    unclearedChecks,
    today,
    leadDays,
    staleCheckAfterDays,
  })
})
