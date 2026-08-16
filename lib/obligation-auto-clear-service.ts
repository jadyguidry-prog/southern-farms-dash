// The impure edge around lib/obligation-auto-clear.ts: reads the ledger, reads the
// clock once, and performs the tier-1 writes.
//
// Split from the pure module so the matching rules stay testable without a database,
// following the pattern of growth-planner-service.ts. Everything that decides anything
// lives in the pure module; this file only fetches, writes, and journals.

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getObligationPayments } from '@/lib/bill-pay-service'
import { getBusinessSettings, SETTING_DEFAULTS } from '@/lib/queries'
import {
  classifyClearCandidates,
  type AutoClearObligation,
  type AutoClearPayment,
  type AutoClearResult,
  type AutoClearTxn,
} from '@/lib/obligation-auto-clear'

/** Minimal client surface, so a service-role client and a cookie client both work. */
type DbLike = {
  from: (table: string) => any
}

const PAGE = 1000

async function fetchTxns(db: DbLike, since: string): Promise<AutoClearTxn[]> {
  const out: AutoClearTxn[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('financial_transactions')
      .select('id, transaction_date, amount, description, check_number, transaction_type')
      .is('deleted_at', null)
      .in('transaction_type', ['expense', 'payment'])
      .gte('transaction_date', since)
      .order('transaction_date', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as AutoClearTxn[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

async function fetchObligations(db: DbLike): Promise<AutoClearObligation[]> {
  const { data, error } = await db
    .from('cash_obligations')
    .select('id, obligation_name, vendor_name, amount, status, active, payment_method')
  if (error) throw new Error(error.message)
  return (data ?? []).map((o: Record<string, unknown>) => ({
    id: String(o.id),
    obligationName: String(o.obligation_name ?? ''),
    vendorName: String(o.vendor_name ?? ''),
    amount: Number(o.amount) || 0,
    status: String(o.status ?? 'Pending'),
    active: o.active !== false,
    paymentMethod: String(o.payment_method ?? ''),
  }))
}

async function fetchPayments(db: DbLike): Promise<AutoClearPayment[]> {
  // Void rows are read too: a void payment must never be re-cleared, and the pure
  // module needs to see it in order to skip it.
  const out: AutoClearPayment[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('obligation_payments')
      .select('id, obligation_id, status, check_number, amount, payment_date, payee_name')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Record<string, unknown>[]
    out.push(
      ...rows.map((p) => ({
        id: String(p.id),
        obligationId: p.obligation_id ? String(p.obligation_id) : null,
        status: String(p.status ?? 'outstanding'),
        checkNumber: p.check_number ? String(p.check_number) : null,
        amount: Number(p.amount) || 0,
        paymentDate: String(p.payment_date ?? '').slice(0, 10),
        payee: String(p.payee_name ?? ''),
      })),
    )
    if (rows.length < PAGE) break
  }
  return out
}

/**
 * Read the settings this module needs.
 *
 * Deliberately NOT `?? 0`-guarded: a failed settings read must throw rather than
 * silently substitute a plausible-looking number. A zero review window would quietly
 * empty the queue and look like "nothing needs attention", which is the most dangerous
 * possible failure mode for this feature.
 */
async function windowSettings(): Promise<{ orphanReviewDays: number; clearWindowDays: number }> {
  const s = await getBusinessSettings()
  const orphan = Number(s.orphan_check_review_days)
  const window = Number(s.check_clear_window_days)
  if (!Number.isFinite(orphan) || orphan <= 0) {
    throw new Error('orphan_check_review_days is not a usable number')
  }
  if (!Number.isFinite(window) || window <= 0) {
    throw new Error('check_clear_window_days is not a usable number')
  }
  return { orphanReviewDays: orphan, clearWindowDays: window }
}

/**
 * Classify without writing. Used by the page and the advisor.
 *
 * Wrapped in React `cache` so the bill-pay page, the dashboard card and the advisor
 * cannot each run their own pass and disagree within a single request — the same
 * one-shared-loader discipline the growth surfaces use.
 */
export const getAutoClearCandidates = cache(async (): Promise<AutoClearResult> => {
  const supabase = await createClient()
  const today = new Date().toISOString().slice(0, 10)

  try {
    const opts = await windowSettings()
    const since = new Date(Date.now() - opts.clearWindowDays * 86_400_000)
      .toISOString()
      .slice(0, 10)

    const [obligations, payments, txns] = await Promise.all([
      fetchObligations(supabase),
      getObligationPayments(),
      fetchTxns(supabase, since),
    ])

    const linked = payments
      .map((p) => p.clearedTransactionId)
      .filter((x): x is string => Boolean(x))

    return classifyClearCandidates(
      obligations,
      payments.map((p) => ({
        id: p.id,
        obligationId: p.obligationId,
        status: p.status,
        checkNumber: p.checkNumber,
        amount: p.amount,
        paymentDate: p.paymentDate,
        payee: p.payeeName,
      })),
      txns,
      linked,
      today,
      opts,
    )
  } catch (err) {
    // Degrade to "nothing found" rather than blanking the page. Logged so a real
    // failure is visible instead of looking like a clean queue.
    console.log('[v0] getAutoClearCandidates failed:', err)
    return { autoClear: [], review: [] }
  }
})

export type AutoClearRunSummary = {
  cleared: number
  needsReview: number
  skipped: number
  errors: string[]
}

/**
 * Apply the tier-1 matches: mark each payment cleared and stamp the bank row that
 * proves it.
 *
 * Takes an injected client so the Plaid sync (service role, no cookies) and a server
 * action (cookie-scoped) can share one implementation. Never trusts a caller-supplied
 * match list — it always re-derives from the database.
 */
export async function applyAutoClear(
  db: DbLike,
  opts: {
    obligations: AutoClearObligation[]
    payments: AutoClearPayment[]
    transactions: AutoClearTxn[]
    linkedTransactionIds: string[]
    todayISO: string
    orphanReviewDays: number
    clearWindowDays: number
    actor: string | null
  },
): Promise<AutoClearRunSummary> {
  const result = classifyClearCandidates(
    opts.obligations,
    opts.payments,
    opts.transactions,
    opts.linkedTransactionIds,
    opts.todayISO,
    { orphanReviewDays: opts.orphanReviewDays, clearWindowDays: opts.clearWindowDays },
  )

  const summary: AutoClearRunSummary = {
    cleared: 0,
    needsReview: result.review.length,
    skipped: 0,
    errors: [],
  }

  for (const m of result.autoClear) {
    // Guarded on status so two concurrent passes cannot both clear the same payment;
    // the loser updates zero rows rather than double-writing.
    const { data, error } = await db
      .from('obligation_payments')
      .update({
        status: 'cleared',
        cleared_date: m.postedDate,
        cleared_transaction_id: m.transactionId,
      })
      .eq('id', m.paymentId)
      .eq('status', 'outstanding')
      .select('id')

    if (error) {
      // The unique index on cleared_transaction_id is the real backstop: if this bank
      // row already proved another payment, skip rather than fail the whole run.
      if ((error as { code?: string }).code === '23505') {
        summary.skipped++
        continue
      }
      summary.errors.push(`${m.label}: ${error.message}`)
      continue
    }
    if (!data || data.length === 0) {
      summary.skipped++
      continue
    }

    summary.cleared++
    // `source` distinguishes an automatic check match from the ACH reconciler
    // ('bank_auto'), a confirmed suggestion ('bank_match') and hand entry, so the owner
    // can always see exactly what the machine decided on its own.
    await db.from('obligation_payment_audit').insert({
      payment_id: m.paymentId,
      action: 'cleared',
      detail: {
        source: 'bank_auto_check',
        transactionId: m.transactionId,
        checkNumber: m.checkNumber,
        clearedDate: m.postedDate,
        amount: m.amount,
        label: m.label,
      },
      created_by: opts.actor,
    })
  }

  return summary
}

/**
 * Run tier-1 auto-clear against the whole ledger with an injected client.
 *
 * The single entry point for both the Plaid sync and the manual action, so the two
 * paths cannot drift apart in what they consider certain.
 */
export async function runAutoClear(
  db: DbLike,
  actor: string | null,
): Promise<AutoClearRunSummary> {
  const today = new Date().toISOString().slice(0, 10)

  // The sync path runs with a service-role client and no request cookies, so
  // getBusinessSettings (which builds a cookie-scoped client) is not always reachable.
  // Read the table directly and fall back to the shared defaults, which are the same
  // constants getBusinessSettings starts from — not invented numbers.
  let orphanReviewDays = SETTING_DEFAULTS.orphan_check_review_days
  let clearWindowDays = SETTING_DEFAULTS.check_clear_window_days
  try {
    const { data } = await db
      .from('business_settings')
      .select('setting_key, value')
      .in('setting_key', ['orphan_check_review_days', 'check_clear_window_days'])
    for (const row of (data ?? []) as { setting_key: string; value: number | string }[]) {
      const v = Number(row.value)
      if (!Number.isFinite(v) || v <= 0) continue
      if (row.setting_key === 'orphan_check_review_days') orphanReviewDays = v
      if (row.setting_key === 'check_clear_window_days') clearWindowDays = v
    }
  } catch (err) {
    console.log('[v0] runAutoClear: settings unreadable, using defaults:', err)
  }

  const since = new Date(Date.now() - clearWindowDays * 86_400_000).toISOString().slice(0, 10)

  const [obligations, payments, transactions] = await Promise.all([
    fetchObligations(db),
    fetchPayments(db),
    fetchTxns(db, since),
  ])

  // Which bank rows are already spoken for. Read separately because fetchPayments does
  // not select cleared_transaction_id (the pure module has no use for it). Void rows are
  // excluded: a voided payment releases its bank row for a legitimate re-match.
  const { data: linkRows } = await db
    .from('obligation_payments')
    .select('cleared_transaction_id')
    .not('cleared_transaction_id', 'is', null)
    .neq('status', 'void')
  const linkedTransactionIds = ((linkRows ?? []) as { cleared_transaction_id: string | null }[])
    .map((r) => r.cleared_transaction_id)
    .filter((x): x is string => Boolean(x))

  return applyAutoClear(db, {
    obligations,
    payments,
    transactions,
    linkedTransactionIds,
    todayISO: today,
    orphanReviewDays,
    clearWindowDays,
    actor,
  })
}
