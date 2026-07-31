// Server-side loader for the CHECK Resolution screen and the overlay-aware COGS
// figures that depend on it.
//
// The bank export records `CHECK # 1317` with no payee. 201 such checks carry
// $292K — roughly twice the COGS that IS categorized — so gross profit cannot be
// trusted until the owner says who was paid.
//
// The central rule here: resolutions are an OVERLAY stored in
// `check_resolutions`. `financial_transactions.expense_category` is never
// written. The bank export stays verbatim so any decision can be undone and the
// original re-read, and so a resolution can never be mistaken for source data.
//
// Nothing in this file writes. Writes live in `app/check-resolution/actions.ts`.

import { createClient } from '@/lib/supabase/server'
import {
  parseCheckNumber,
  summarizeChecks,
  suggestCheckGroups,
  checkResolutionProgress,
  type CheckRow,
  type CheckResolution,
  type CheckReviewSummary,
  type CheckSuggestion,
  type CheckResolutionProgress,
} from '@/lib/check-review'
import { deriveSalesCoverage, monthSalesCoverage } from '@/lib/labor-service'

const PAGE_SIZE = 1000

/**
 * Does a category represent cost of goods?
 *
 * Matches on the `COGS` token rather than the four exact literals
 * (`Meat / COGS`, `Food / COGS`, `Inventory / COGS`, `Bakery / COGS`), so a
 * resolution saved under any of those spellings — or a plain `COGS` — counts.
 *
 * Note this does NOT route through `canonicalCategory`: that function
 * deliberately ignores `CATEGORY_ALIASES` so nothing is regrouped without the
 * owner's approval, and it would return `Meat / COGS` unchanged. Testing the
 * token directly keeps this independent of whether the alias merge is approved.
 */
export function isCogsCategory(category: string): boolean {
  const raw = String(category ?? '').trim()
  if (!raw) return false
  return /\bcogs\b/i.test(raw)
}

/** A CHECK line is identified by its description, matching the existing queue. */
function isCheckDescription(description: string): boolean {
  return /^\s*CHECK\b/i.test(description ?? '')
}

type RawTxn = {
  id: string
  transaction_date: string
  description: string | null
  normalized_description: string | null
  amount: number | string | null
  transaction_type: string | null
  review_status: string | null
  vendor_id: string | null
  expense_category: string | null
  account_name: string | null
  check_number: string | null
}

async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let page = 0; ; page += 1) {
    const from = page * PAGE_SIZE
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    out.push(...rows)
    // A short page means we reached the end; the 1000-row cap silently
    // truncates otherwise, which would understate the backlog.
    if (rows.length < PAGE_SIZE) break
  }
  return out
}

export type CheckBulkAction = {
  bulkActionId: string
  action: string
  rowCount: number
  /** Dollars covered by the batch, so the owner can judge what undo would move. */
  amount: number
  payee: string | null
  category: string | null
  actorEmail: string | null
  createdAt: string
  reason: string | null
}

export type CheckResolutionDataset = {
  /** Every live CHECK line, oldest first. */
  checks: CheckRow[]
  /** Overlay rows, keyed by transaction id (approved and pending alike). */
  resolutions: CheckResolution[]
  summary: CheckReviewSummary
  suggestions: CheckSuggestion[]
  progress: CheckResolutionProgress
  /** Undoable batches, newest first. */
  recentActions: CheckBulkAction[]
  /** Category names already in use, so resolutions reuse the owner's own vocabulary. */
  categoryOptions: string[]
  /** Payees already used on resolutions, for quick reuse. */
  payeeOptions: string[]
  /** True when the overlay tables are missing, so the UI can explain rather than crash. */
  overlayUnavailable: boolean
}

function mapResolution(row: Record<string, unknown>): CheckResolution {
  return {
    financialTransactionId: String(row.financial_transaction_id ?? ''),
    checkNumber: (row.check_number as string | null) ?? null,
    resolvedPayee: (row.resolved_payee as string | null) ?? null,
    resolvedVendorId: (row.resolved_vendor_id as string | null) ?? null,
    resolvedCategory: (row.resolved_category as string | null) ?? null,
    memo: (row.memo as string | null) ?? null,
    businessPurpose: (row.business_purpose as string | null) ?? null,
    reviewStatus:
      (row.review_status as CheckResolution['reviewStatus']) ?? 'pending',
    confidence: (row.confidence as CheckResolution['confidence']) ?? null,
    resolutionSource: (row.resolution_source as string | null) ?? null,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    bulkActionId: (row.bulk_action_id as string | null) ?? null,
  }
}

/** Load every CHECK line plus any resolutions the owner has already saved. */
export async function getCheckResolutionDataset(): Promise<CheckResolutionDataset> {
  const supabase = await createClient()

  const txns = await fetchAllPages<RawTxn>((from, to) =>
    supabase
      .from('financial_transactions')
      .select(
        'id, transaction_date, description, normalized_description, amount, transaction_type, review_status, vendor_id, expense_category, account_name, check_number',
      )
      .is('deleted_at', null)
      .order('transaction_date', { ascending: true })
      .range(from, to),
  )

  const checks: CheckRow[] = txns
    .filter((r) => isCheckDescription(r.description ?? r.normalized_description ?? ''))
    .map((r) => {
      const description = r.description ?? r.normalized_description ?? ''
      return {
        id: r.id,
        transactionDate: (r.transaction_date ?? '').slice(0, 10),
        amount: Math.abs(Number(r.amount) || 0),
        // Prefer the stored column, fall back to parsing the text. 196 of 201
        // rows have the column populated; the rest are bare `CHECK` lines.
        checkNumber: r.check_number ?? parseCheckNumber(description),
        description,
        accountName: r.account_name ?? '',
        expenseCategory: (r.expense_category ?? '').trim(),
        vendorId: r.vendor_id ?? null,
        reviewStatus: r.review_status ?? '',
      }
    })

  let resolutions: CheckResolution[] = []
  let overlayUnavailable = false
  const { data: resRows, error: resError } = await supabase
    .from('check_resolutions')
    .select(
      'financial_transaction_id, check_number, resolved_payee, resolved_vendor_id, resolved_category, memo, business_purpose, review_status, confidence, resolution_source, reviewed_by, reviewed_at, bulk_action_id',
    )
  if (resError) {
    // Surface this as a flag instead of throwing: the screen is still useful
    // read-only, and a hard failure would hide the backlog entirely.
    overlayUnavailable = true
  } else {
    resolutions = (resRows ?? []).map((r) => mapResolution(r as Record<string, unknown>))
  }

  // Undoable batches. Grouped in memory because one bulk action spans many audit
  // rows and the owner thinks in batches ("undo that cluster"), not rows.
  const amountById = new Map(checks.map((c) => [c.id, c.amount]))
  const recentActions: CheckBulkAction[] = []
  if (!overlayUnavailable) {
    const { data: auditRows } = await supabase
      .from('check_resolution_audit')
      .select(
        'bulk_action_id, financial_transaction_id, action, new_overlay, actor_email, created_at, reason',
      )
      .is('reverted_at', null)
      .order('created_at', { ascending: false })
      .limit(500)

    const grouped = new Map<string, CheckBulkAction>()
    for (const row of auditRows ?? []) {
      const id = String(row.bulk_action_id ?? '')
      if (!id) continue
      const overlay = (row.new_overlay ?? {}) as Record<string, unknown>
      const existing = grouped.get(id)
      const amt = amountById.get(String(row.financial_transaction_id ?? '')) ?? 0
      if (existing) {
        existing.rowCount += 1
        existing.amount += amt
        continue
      }
      grouped.set(id, {
        bulkActionId: id,
        action: String(row.action ?? ''),
        rowCount: 1,
        amount: amt,
        payee: (overlay.resolved_payee as string | null) ?? null,
        category: (overlay.resolved_category as string | null) ?? null,
        actorEmail: (row.actor_email as string | null) ?? null,
        createdAt: String(row.created_at ?? ''),
        reason: (row.reason as string | null) ?? null,
      })
    }
    // `undo` entries are records of reversals, not themselves undoable.
    recentActions.push(
      ...[...grouped.values()].filter((a) => a.action !== 'undo').slice(0, 25),
    )
  }

  // Offer the owner's existing category vocabulary rather than inventing a new
  // taxonomy. Includes the four COGS lines, which is what most checks will need.
  const categoryOptions = [
    ...new Set(
      txns
        .map((r) => (r.expense_category ?? '').trim())
        .filter((c) => c.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b))

  const payeeOptions = [
    ...new Set(
      resolutions
        .map((r) => (r.resolvedPayee ?? '').trim())
        .filter((p) => p.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b))

  return {
    checks,
    resolutions,
    summary: summarizeChecks(checks),
    suggestions: suggestCheckGroups(checks),
    progress: checkResolutionProgress(checks, resolutions, isCogsCategory),
    recentActions,
    categoryOptions,
    payeeOptions,
    overlayUnavailable,
  }
}

/* ------------------------------------------------------------------ */
/* Overlay-aware COGS                                                  */
/* ------------------------------------------------------------------ */

export type MonthlyCogs = {
  month: string
  /** COGS from `expense_category` on non-CHECK lines — the categorized base. */
  baseCogs: number
  /** COGS added by approved check resolutions. */
  resolvedCheckCogs: number
  /** baseCogs + resolvedCheckCogs. */
  totalCogs: number
  /** Check dollars in this month with no approved resolution yet. */
  unresolvedCheckAmount: number
  unresolvedCheckCount: number
  /** Square net sales for the month, 0 when none recorded. */
  netSales: number
  /**
   * Whether sales cover the whole month, via the SAME `monthSalesCoverage` guard
   * the payroll module uses. A partial month understates sales and would inflate
   * margin, so no margin is ever quoted on one.
   */
  salesComplete: boolean
}

/**
 * Monthly COGS with approved check resolutions folded in.
 *
 * `unresolvedCheckAmount` travels alongside every figure on purpose: it is the
 * known unknown. A month with $48K of unresolved checks has a COGS number that
 * could still move materially, and every consumer needs to see that rather than
 * treat `totalCogs` as final.
 */
export function deriveMonthlyCogs(
  transactions: {
    transactionDate: string
    amount: number
    expenseCategory: string
    isCheck: boolean
    id: string
  }[],
  resolutions: CheckResolution[],
  /**
   * Monthly sales keyed `YYYY-MM`, with the payroll module's completeness verdict.
   * Optional so COGS-only callers (and tests) need not supply it.
   */
  sales: Map<string, { netSales: number; complete: boolean }> = new Map(),
): MonthlyCogs[] {
  const approved = new Map(
    resolutions
      .filter((r) => r.reviewStatus === 'approved')
      .map((r) => [r.financialTransactionId, r]),
  )
  const months = new Map<string, MonthlyCogs>()
  const bucket = (month: string): MonthlyCogs => {
    const existing = months.get(month)
    if (existing) return existing
    const fresh: MonthlyCogs = {
      month,
      baseCogs: 0,
      resolvedCheckCogs: 0,
      totalCogs: 0,
      unresolvedCheckAmount: 0,
      unresolvedCheckCount: 0,
      netSales: sales.get(month)?.netSales ?? 0,
      salesComplete: sales.get(month)?.complete ?? false,
    }
    months.set(month, fresh)
    return fresh
  }

  // Seed from sales too, so a month with sales but NO cost of goods still appears
  // — that gap is exactly what needs reporting, and it would otherwise vanish.
  for (const month of sales.keys()) bucket(month)

  for (const t of transactions) {
    const month = (t.transactionDate ?? '').slice(0, 7)
    if (month.length !== 7) continue
    const amt = Math.abs(Number(t.amount) || 0)
    const b = bucket(month)

    if (t.isCheck) {
      const res = approved.get(t.id)
      if (!res) {
        b.unresolvedCheckAmount += amt
        b.unresolvedCheckCount += 1
      } else if (res.resolvedCategory && isCogsCategory(res.resolvedCategory)) {
        b.resolvedCheckCogs += amt
      }
      // A check resolved to a NON-COGS category is fully accounted for: it is
      // neither COGS nor an open question, so it adds to neither total.
      continue
    }

    if (isCogsCategory(t.expenseCategory)) b.baseCogs += amt
  }

  for (const b of months.values()) b.totalCogs = b.baseCogs + b.resolvedCheckCogs
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
}

export type GrossProfitReadiness = {
  /** True only when unresolved check dollars are small enough to trust a margin. */
  ready: boolean
  totalCheckAmount: number
  unresolvedCheckAmount: number
  unresolvedCheckCount: number
  identifiedCogs: number
  /** Unresolved checks as a multiple of identified COGS — the headline risk. */
  unresolvedVsCogsRatio: number | null
  reason: string
}

/**
 * Whether gross profit can be reported honestly yet.
 *
 * Deliberately conservative. Publishing a 57.7% margin while $292K of checks are
 * unattributed would look authoritative and be wrong; the 36–96% swing across
 * months is the tell. The gate is unresolved check dollars measured against
 * identified COGS, because that ratio is what determines how far the margin could
 * still move.
 */
export function grossProfitReadiness(
  months: MonthlyCogs[],
  totalCheckAmount: number,
  { tolerancePct = 5 }: { tolerancePct?: number } = {},
): GrossProfitReadiness {
  const unresolvedCheckAmount = months.reduce((s, m) => s + m.unresolvedCheckAmount, 0)
  const unresolvedCheckCount = months.reduce((s, m) => s + m.unresolvedCheckCount, 0)
  const identifiedCogs = months.reduce((s, m) => s + m.totalCogs, 0)
  const ratio = identifiedCogs > 0 ? unresolvedCheckAmount / identifiedCogs : null

  // Tolerance is relative to COGS, not to sales: a dollar of missing COGS moves
  // gross profit by a dollar regardless of how large sales happen to be.
  const threshold = identifiedCogs * (tolerancePct / 100)
  const ready = unresolvedCheckAmount <= threshold

  let reason: string
  if (ready) {
    reason = `Unresolved checks total ${fmt(unresolvedCheckAmount)}, under ${tolerancePct}% of the ${fmt(identifiedCogs)} in identified COGS, so gross profit can be reported with a stated margin of error.`
  } else if (ratio != null && ratio >= 1) {
    reason = `${unresolvedCheckCount} unresolved checks total ${fmt(unresolvedCheckAmount)} — ${ratio.toFixed(1)}× the ${fmt(identifiedCogs)} in identified COGS. Gross profit would be overstated by an unknown but potentially large amount, so no margin is shown.`
  } else {
    reason = `${unresolvedCheckCount} unresolved checks total ${fmt(unresolvedCheckAmount)} against ${fmt(identifiedCogs)} in identified COGS. Enough could be supplier spend to move the margin materially, so no margin is shown yet.`
  }

  return {
    ready,
    totalCheckAmount,
    unresolvedCheckAmount,
    unresolvedCheckCount,
    identifiedCogs,
    unresolvedVsCogsRatio: ratio,
    reason,
  }
}

function fmt(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/* ------------------------------------------------------------------ */
/* Shared snapshot                                                     */
/* ------------------------------------------------------------------ */

export type CheckResolutionSnapshot = {
  hasChecks: boolean
  progress: CheckResolutionProgress
  readiness: GrossProfitReadiness
  monthlyCogs: MonthlyCogs[]
  /** How many months still contain unattributed checks. */
  monthsWithUnresolved: number
  /** Largest same-amount groups still outstanding, biggest dollars first. */
  topClusters: { amount: number; count: number; total: number; cadence: string | null }[]
  /** Complete months with sales but zero categorized cost of goods. */
  monthsMissingCogs: string[]
  /**
   * Unresolved checks that carry a check number, so they can be looked up
   * directly in the bank portal rather than hunted by date and amount.
   */
  unresolvedWithCheckNumber: number
  /** Unresolved checks that already have a scan attached and can be named now. */
  unresolvedWithScan: number
};

/**
 * The single contract Dashboard, AI Advisor and Reporting all read, mirroring
 * `getLaborHealthSnapshot`. One source means the three surfaces cannot disagree
 * about how trustworthy gross profit currently is.
 */
export async function getCheckResolutionSnapshot(): Promise<CheckResolutionSnapshot> {
  const supabase = await createClient()

  const txns = await fetchAllPages<RawTxn>((from, to) =>
    supabase
      .from('financial_transactions')
      .select(
        'id, transaction_date, description, normalized_description, amount, transaction_type, review_status, vendor_id, expense_category, account_name, check_number',
      )
      .is('deleted_at', null)
      .order('transaction_date', { ascending: true })
      .range(from, to),
  )

  let resolutions: CheckResolution[] = []
  const { data: resRows } = await supabase
    .from('check_resolutions')
    .select(
      'financial_transaction_id, check_number, resolved_payee, resolved_vendor_id, resolved_category, memo, business_purpose, review_status, confidence, resolution_source, reviewed_by, reviewed_at, bulk_action_id',
    )
  resolutions = (resRows ?? []).map((r) => mapResolution(r as Record<string, unknown>))

  const prepared = txns.map((r) => {
    const description = r.description ?? r.normalized_description ?? ''
    return {
      id: r.id,
      transactionDate: (r.transaction_date ?? '').slice(0, 10),
      amount: Math.abs(Number(r.amount) || 0),
      expenseCategory: (r.expense_category ?? '').trim(),
      isCheck: isCheckDescription(description),
    }
  })

  const byId = new Map(txns.map((r) => [r.id, r]))
  const checkRows: CheckRow[] = prepared
    .filter((r) => r.isCheck)
    .map((r) => {
      const raw = byId.get(r.id)
      const description = raw?.description ?? raw?.normalized_description ?? ''
      return {
        id: r.id,
        transactionDate: r.transactionDate,
        amount: r.amount,
        // Keep the check number: it drives sequence detection, and dropping it
        // would silently disable half the grouping signals.
        checkNumber: raw?.check_number ?? parseCheckNumber(description),
        description,
        accountName: raw?.account_name ?? '',
        expenseCategory: r.expenseCategory,
        vendorId: raw?.vendor_id ?? null,
        reviewStatus: raw?.review_status ?? '',
      }
    })

  // Reuse the payroll module's coverage logic rather than re-deriving "is this
  // month complete" — one definition means gross profit and payroll can never
  // disagree about which months are safe to quote.
  const salesRows = await fetchAllPages<{ sale_date: string; net_sales: number | string | null }>(
    (from, to) =>
      supabase
        .from('sales_daily')
        .select('sale_date, net_sales')
        .order('sale_date', { ascending: true })
        .range(from, to),
  )
  const coverage = deriveSalesCoverage(
    salesRows.map((r) => ({
      saleDate: (r.sale_date ?? '').slice(0, 10),
      netSales: Number(r.net_sales) || 0,
    })),
  )
  const salesByMonth = new Map<string, { netSales: number; complete: boolean }>()
  for (const [month, netSales] of coverage.netByMonth) {
    salesByMonth.set(month, {
      netSales,
      complete: monthSalesCoverage(month, coverage) === 'complete',
    })
  }

  const monthlyCogs = deriveMonthlyCogs(prepared, resolutions, salesByMonth)
  const progress = checkResolutionProgress(checkRows, resolutions, isCogsCategory)
  // Readiness is judged on what is still UNRESOLVED, not the lifetime total —
  // using the total would keep the gate closed forever even after every check
  // had been attributed.
  const readiness = grossProfitReadiness(monthlyCogs, progress.pendingAmount)

  // Only unresolved checks are worth suggesting groups for; resolved ones are
  // already answered and would pad the list the owner is working through.
  const approvedIds = new Set(
    resolutions.filter((r) => r.reviewStatus === 'approved').map((r) => r.financialTransactionId),
  )
  const pendingRows = checkRows.filter((r) => !approvedIds.has(r.id))
  const topClusters = suggestCheckGroups(pendingRows)
    .filter((s) => s.kind === 'amount-cluster')
    .slice(0, 3)
    .map((s) => ({
      amount: s.count > 0 ? s.total / s.count : 0,
      count: s.count,
      total: s.total,
      cadence: s.cadence?.regular ? s.cadence.label : null,
    }))

  // Which unresolved checks already have a scan on file. Counted from the same
  // pending set so the number can never exceed the outstanding count.
  const pendingIds = pendingRows.map((r) => r.id)
  let unresolvedWithScan = 0
  if (pendingIds.length > 0) {
    const { data: docRows } = await supabase
      .from('transaction_documents')
      .select('transaction_id')
      .is('deleted_at', null)
      .in('transaction_id', pendingIds)
    unresolvedWithScan = new Set((docRows ?? []).map((d) => d.transaction_id)).size
  }

  return {
    hasChecks: checkRows.length > 0,
    progress,
    readiness,
    monthlyCogs,
    unresolvedWithCheckNumber: pendingRows.filter((r) => r.checkNumber != null).length,
    unresolvedWithScan,
    monthsWithUnresolved: monthlyCogs.filter((m) => m.unresolvedCheckCount > 0).length,
    topClusters,
    // Complete months with sales but nothing categorized as cost of goods — a
    // different failure from unattributed checks, and a worse one for margin.
    monthsMissingCogs: monthlyCogs
      .filter((m) => m.salesComplete && m.netSales > 0 && m.baseCogs <= 0)
      .map((m) => m.month),
  }
}
