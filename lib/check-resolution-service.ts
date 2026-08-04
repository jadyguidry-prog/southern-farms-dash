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
  checkResolvedVia,
  type CheckRow,
  type CheckResolution,
  type CheckReviewSummary,
  type CheckSuggestion,
  type CheckResolutionProgress,
} from '@/lib/check-review'
import { deriveSalesCoverage, monthSalesCoverage } from '@/lib/labor-service'
import {
  deriveSalesTaxReview,
  type SalesTaxReviewGroup,
} from '@/lib/sales-tax-review'
// Reused rather than re-derived: `deriveMonthlyCashFlow` already owns the one
// definition of "this month's bank data was imported".
import { deriveMonthlyCashFlow } from '@/lib/cash-flow-service'
import type { TransactionType, ReviewStatus } from '@/lib/transactions'

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
  /**
   * Sales tax still filed as an operating expense, or null when there is none.
   * Surfaced here rather than acted on: the owner decides the treatment.
   */
  salesTaxReview: SalesTaxReviewGroup | null
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

  // Sales tax filed as an expense. Derived from the same `txns` already in hand,
  // so this costs no extra query.
  const salesTaxReview = deriveSalesTaxReview(
    txns.map((r) => ({
      id: r.id,
      transactionDate: (r.transaction_date ?? '').slice(0, 10),
      amount: Math.abs(Number(r.amount) || 0),
      description: r.description ?? r.normalized_description ?? '',
      expenseCategory: (r.expense_category ?? '').trim(),
      reviewStatus: (r.review_status ?? '').trim(),
      transactionType: (r.transaction_type ?? '').trim(),
    })),
  )

  return {
    checks,
    resolutions,
    salesTaxReview,
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
  /**
   * Whether the month's BANK data was imported, via the SAME `inflow > 0` test
   * `deriveMonthlyCashFlow` uses to decide a cash-flow month is complete.
   *
   * This is the guard that catches the worst failure mode. A month where only a
   * card statement was imported has sales but almost no recorded spend, so its
   * COGS is a fragment of the truth and the margin computes to ~99%. That reads
   * as a spectacular month rather than as missing data. Reusing the cash-flow
   * definition rather than inventing a ratio threshold means "complete month"
   * cannot come to mean two different things in two modules.
   */
  bankDataComplete: boolean
  /**
   * Why no margin can be quoted, or `null` when one can. Computed here so the
   * Dashboard, Reporting and the Advisor cannot apply different standards — the
   * report table once showed a margin the gauge would have refused to draw.
   */
  withheldReason: MarginWithheldReason | null
  /** Convenience for `withheldReason === null`. */
  quotable: boolean
  /** `netSales - totalCogs`, or null when not quotable. Never a misleading 0. */
  grossProfit: number | null
  /** Gross margin as a percentage, or null when not quotable. */
  marginPct: number | null
}

/**
 * The reasons a month's margin is withheld, ordered by how fundamental they are.
 *
 * Kept as a discriminated value rather than a boolean because the REMEDY differs
 * for each: missing bank data needs an import, `no-cogs` needs categorization,
 * and `unresolved-checks` needs the owner to name payees. Collapsing them into
 * one "can't show this" bucket would tell the owner to do the wrong job.
 */
export type MarginWithheldReason =
  | 'no-sales'
  | 'partial-sales'
  | 'bank-data-missing'
  | 'no-cogs'
  | 'unresolved-checks'

/** Short human phrase for a withheld margin, for table cells and tooltips. */
export function marginWithheldLabel(reason: MarginWithheldReason): string {
  switch (reason) {
    case 'no-sales':
      return 'no sales recorded'
    case 'partial-sales':
      return 'sales cover only part of the month'
    case 'bank-data-missing':
      return 'bank transactions for this month not imported'
    case 'no-cogs':
      return 'no cost of goods categorized'
    case 'unresolved-checks':
      return 'checks in this month have no payee'
  }
}

/**
 * Whether a month can carry a margin, and if not, why.
 *
 * Pure and exported so verification scripts test the same predicate the UI uses
 * instead of re-deriving it — a re-implementation would drift.
 */
export function marginWithheldReason(m: {
  netSales: number
  salesComplete: boolean
  bankDataComplete: boolean
  totalCogs: number
  unresolvedCheckAmount: number
}): MarginWithheldReason | null {
  if (m.netSales <= 0) return 'no-sales'
  if (!m.salesComplete) return 'partial-sales'
  // Checked BEFORE `no-cogs`, because missing bank data is the CAUSE of the
  // thin COGS figure. Reporting it as a categorization gap would send the owner
  // to re-categorize transactions that were never imported.
  if (!m.bankDataComplete) return 'bank-data-missing'
  if (m.totalCogs <= 0) return 'no-cogs'
  if (m.unresolvedCheckAmount > 0) return 'unresolved-checks'
  return null
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
    /**
     * The row's own review status. Optional so existing COGS-only callers and
     * tests keep working; when absent a row is simply never treated as excluded.
     */
    reviewStatus?: string
  }[],
  resolutions: CheckResolution[],
  /**
   * Monthly sales keyed `YYYY-MM`, with the payroll module's completeness verdict.
   * Optional so COGS-only callers (and tests) need not supply it.
   */
  sales: Map<string, { netSales: number; complete: boolean }> = new Map(),
  /**
   * Whether each month's bank data was imported, keyed `YYYY-MM`, from
   * `deriveMonthlyCashFlow`. A month ABSENT from this map is treated as NOT
   * imported, matching how `sales` defaults to incomplete: the conservative
   * direction withholds a margin, and the alternative would quote one for a
   * month whose costs are unknown.
   */
  bankCoverage: Map<string, boolean> = new Map(),
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
      bankDataComplete: bankCoverage.get(month) ?? false,
      // Filled in by the finalization pass below, once totals are known.
      withheldReason: null,
      quotable: false,
      grossProfit: null,
      marginPct: null,
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
      const via = checkResolvedVia(
        { expenseCategory: t.expenseCategory, reviewStatus: t.reviewStatus ?? '' },
        res,
      )
      if (via === 'unresolved') {
        b.unresolvedCheckAmount += amt
        b.unresolvedCheckCount += 1
      } else if (via === 'overlay') {
        if (res?.resolvedCategory && isCogsCategory(res.resolvedCategory)) {
          b.resolvedCheckCogs += amt
        }
      } else if (via === 'categorized' && isCogsCategory(t.expenseCategory)) {
        // A check the General Ledger already categorized as cost of goods is
        // real COGS. Counting it here — and not as unresolved — is what keeps
        // this figure equal to the one Reporting and the Dashboard show.
        b.resolvedCheckCogs += amt
      }
      // A check resolved to a NON-COGS category, or excluded, is fully accounted
      // for: it is neither COGS nor an open question, so it adds to neither.
      continue
    }

    // Excluded non-check rows are not spend at all, matching cash flow and
    // vendor spend, so they must not inflate the categorized COGS base.
    if ((t.reviewStatus ?? '').trim() === 'excluded') continue
    if (isCogsCategory(t.expenseCategory)) b.baseCogs += amt
  }

  // Finalize: totals first, then the single quotability verdict every surface
  // reads. Computing the margin HERE — rather than in each component — is what
  // stops the report table and the Dashboard gauge from disagreeing.
  for (const b of months.values()) {
    b.totalCogs = b.baseCogs + b.resolvedCheckCogs
    b.withheldReason = marginWithheldReason(b)
    b.quotable = b.withheldReason === null
    // Null rather than 0 when withheld: a 0 here would render as a real
    // break-even month instead of as an unknown.
    b.grossProfit = b.quotable ? b.netSales - b.totalCogs : null
    b.marginPct =
      b.quotable && b.netSales > 0
        ? ((b.netSales - b.totalCogs) / b.netSales) * 100
        : null
  }
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
  /**
   * Complete months with imported bank data and sales but zero categorized cost
   * of goods — a genuine CATEGORIZATION gap the owner can fix by categorizing.
   */
  monthsMissingCogs: string[]
  /**
   * Months with sales whose bank transactions were never imported. Kept separate
   * from `monthsMissingCogs` because the remedy is completely different: these
   * need a statement import, not categorization. Merging them told the owner to
   * re-categorize months that contain no transactions to categorize.
   */
  monthsMissingBankData: string[]
  /**
   * The newest month a margin can honestly be quoted for, or null when none
   * exists. The Dashboard gauge reads this instead of a stored KPI so it cannot
   * render a figure the report table would refuse to show.
   */
  latestQuotableMonth: MonthlyCogs | null
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
      reviewStatus: (r.review_status ?? '').trim(),
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

  // Bank-data coverage comes from the cash-flow module's OWN completeness test
  // (`inflow > 0`) rather than a second definition invented here. A month with
  // only a card statement imported has sales and a fragment of the spend, which
  // computes to a ~99% margin — indistinguishable from a real triumph.
  // `months` is set past the series length so the whole history is classified;
  // the default 12-month window would leave older months absent from the map and
  // therefore treated as un-imported.
  const cashFlowSeries = deriveMonthlyCashFlow(
    txns.map((r) => ({
      id: r.id,
      transactionDate: (r.transaction_date ?? '').slice(0, 10),
      description: r.description ?? '',
      normalizedDescription: r.normalized_description ?? '',
      amount: Number(r.amount) || 0,
      transactionType: (r.transaction_type ?? '') as TransactionType,
      reviewStatus: (r.review_status ?? '') as ReviewStatus,
      vendorId: r.vendor_id ?? null,
      expenseCategory: r.expense_category ?? '',
      accountName: r.account_name ?? '',
    })),
    { months: Number.MAX_SAFE_INTEGER },
  )
  const bankCoverage = new Map(
    cashFlowSeries.series.map((m) => [m.monthKey, m.complete]),
  )

  const monthlyCogs = deriveMonthlyCogs(prepared, resolutions, salesByMonth, bankCoverage)
  const progress = checkResolutionProgress(checkRows, resolutions, isCogsCategory)
  // Readiness is judged on what is still UNRESOLVED, not the lifetime total —
  // using the total would keep the gate closed forever even after every check
  // had been attributed.
  const readiness = grossProfitReadiness(monthlyCogs, progress.pendingAmount)

  // Only unresolved checks are worth suggesting groups for; resolved ones are
  // already answered and would pad the list the owner is working through.
  const approvedById = new Map(
    resolutions
      .filter((r) => r.reviewStatus === 'approved')
      .map((r) => [r.financialTransactionId, r]),
  )
  // The same predicate the progress figures use, so the clusters offered for
  // review and the outstanding total can never describe different sets of rows.
  const pendingRows = checkRows.filter(
    (r) => checkResolvedVia(r, approvedById.get(r.id)) === 'unresolved',
  )
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
    // The two lists are split by REMEDY, not merged into one "no margin" bucket.
    // `no-cogs` means transactions exist but none are categorized as cost of
    // goods; `bank-data-missing` means there are no transactions to categorize.
    monthsMissingCogs: monthlyCogs
      .filter((m) => m.withheldReason === 'no-cogs')
      .map((m) => m.month),
    monthsMissingBankData: monthlyCogs
      .filter((m) => m.withheldReason === 'bank-data-missing')
      .map((m) => m.month),
    // Newest first match wins: scan from the end for the most recent month whose
    // margin passes every guard.
    latestQuotableMonth:
      [...monthlyCogs].reverse().find((m) => m.quotable) ?? null,
  }
}
