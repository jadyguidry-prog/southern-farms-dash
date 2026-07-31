// Server-side loader for the Category Review screen.
//
// Pulls the live transaction data, runs the DB-free proposal/check logic in
// `lib/categories` and `lib/check-review`, and folds in decisions the owner has
// already persisted so nothing is proposed twice. Nothing here writes — writes
// live in `app/category-review/actions.ts`.

import { createClient } from '@/lib/supabase/server'
import { fetchAllPages } from '@/lib/paginate'
import { SPEND_TYPES, SPEND_OFFSET_TYPES } from '@/lib/transactions'
import {
  proposeCategoryMerges,
  type CategoryUsage,
  type MergeProposal,
} from '@/lib/categories'
import {
  parseCheckNumber,
  summarizeChecks,
  type CheckRow,
  type CheckReviewSummary,
} from '@/lib/check-review'
import {
  assessReclassification,
  deriveMerchantName,
  type EvidenceReport,
  type EvidenceRow,
} from '@/lib/reclassify-evidence'

const PAGE_SIZE = 1000

type RawRow = {
  id: string
  transactionDate: string
  description: string
  amount: number
  transactionType: string
  reviewStatus: string
  vendorId: string | null
  expenseCategory: string
  accountName: string
  checkNumber: string | null
}

/** Paginated fetch of every live transaction with the columns this screen needs. */
async function fetchRows(): Promise<RawRow[]> {
  const supabase = await createClient()
  const out: RawRow[] = []

  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from('financial_transactions')
      .select(
        'id, transaction_date, description, amount, transaction_type, review_status, vendor_id, expense_category, account_name, check_number',
      )
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

    if (error) throw new Error(`financial_transactions: ${error.message}`)
    const rows = data ?? []
    out.push(
      ...rows.map((t) => ({
        id: String(t.id),
        transactionDate: String(t.transaction_date ?? ''),
        description: String(t.description ?? ''),
        amount: Number(t.amount ?? 0),
        transactionType: String(t.transaction_type ?? 'expense'),
        reviewStatus: String(t.review_status ?? 'unreviewed'),
        vendorId: t.vendor_id ? String(t.vendor_id) : null,
        expenseCategory: String(t.expense_category ?? ''),
        accountName: String(t.account_name ?? ''),
        checkNumber: t.check_number ? String(t.check_number) : null,
      })),
    )
    if (rows.length < PAGE_SIZE) break
  }

  return out
}

/** Stable signature so a computed proposal can be matched to a persisted one. */
export function proposalSignature(fromCategories: string[], toCategory: string): string {
  return `${[...fromCategories].sort().join('|')}=>${toCategory}`
}

/**
 * Lifecycle of a merge decision.
 *  - `pending`  — detected or saved, but NOT affecting any report yet.
 *  - `approved` — the only state that groups anything, and display-only.
 *  - `rejected` — the owner declined; never suggested again.
 *  - `undone`   — was approved, then reverted; grouping already removed.
 */
export type MergeDecisionStatus = 'pending' | 'approved' | 'rejected' | 'undone'

export type ReviewableMerge = MergeProposal & {
  signature: string
  /** Prior decision, when the owner has already acted on this exact merge. */
  priorStatus: MergeDecisionStatus | null
}

/** A decision the owner has already recorded, for the status board. */
export type DecidedMerge = {
  id: string
  signature: string
  fromCategories: string[]
  toCategory: string
  status: MergeDecisionStatus
  transactionCount: number
  totalAmount: number
  bulkActionId: string | null
  decidedAt: string | null
  decidedBy: string | null
}

export type MistypedFlag = {
  category: string
  count: number
  amount: number
  transactionIds: string[]
  /** Calendar months (yyyy-mm) the flagged rows fall in. */
  months: string[]
  /** Cash totals if the owner approves reclassifying this group to income. */
  resultingCashIn: number
  resultingCashOut: number
  /**
   * What the rows themselves say. The UI must offer reclassification only when
   * this supports it, so a shared label can never move money on its own.
   */
  evidence: EvidenceReport
  /**
   * Corrective expense category derived from the rows' own merchant name, offered
   * when the evidence says "fee, not income". Derived rather than hardcoded so it
   * works for any recurring-fee merchant, not only the one found today. `null`
   * when the descriptions share no clear merchant.
   */
  suggestedExpenseCategory: string | null
}

export type AuditEntry = {
  bulkActionId: string
  action: string
  field: string
  count: number
  sampleFrom: string | null
  sampleTo: string | null
  createdAt: string
  reverted: boolean
}

export type CategoryReviewData = {
  proposals: ReviewableMerge[]
  /** Every recorded decision, for the pending/approved/rejected/undone board. */
  decisions: DecidedMerge[]
  distinctSpendCategories: number
  checks: CheckReviewSummary & { transactionIds: string[] }
  /** Income-style categories sitting on spend rows — likely a mis-type. */
  mistyped: MistypedFlag[]
  recentActions: AuditEntry[]
  transactionCount: number
  /** Live cash totals, so a reclassification can show before-and-after. */
  currentCashIn: number
  currentCashOut: number
}

function isSpendRow(row: RawRow): boolean {
  if (row.reviewStatus === 'excluded') return false
  return (
    SPEND_TYPES.includes(row.transactionType as never) ||
    SPEND_OFFSET_TYPES.includes(row.transactionType as never)
  )
}

/**
 * Income-style labels worth *examining* on a spend row.
 *
 * A match here is only a reason to look, never a conclusion. `Sales Deposit`
 * covers both real Square payouts and the monthly Square service fees, so the
 * verdict comes from `assessReclassification` reading the rows themselves.
 */
const INCOME_CATEGORY_HINTS = ['sales deposit', 'loan proceeds', 'deposit', 'income']

/** How many recent bulk actions the "Recent changes" list shows. */
const RECENT_ACTION_LIMIT = 10

type RawAuditRow = {
  bulk_action_id: string | null
  transaction_id: string | null
  action: string | null
  field: string | null
  previous_value: string | null
  new_value: string | null
  created_at: string | null
  reverted_at: string | null
}

/**
 * Recent bulk actions, with *every* entry belonging to them.
 *
 * Fetched in two steps on purpose. A single capped query cannot do this job:
 * one write logs one entry per changed *field* (a recategorize logs both
 * `expense_category` and `review_status`), so entries outnumber rows and a flat
 * `.limit()` can slice a bulk action in half — leaving the history to report a
 * fraction of what actually changed. So: identify the newest action ids first,
 * then page in all of their entries.
 */
async function fetchRecentAuditEntries(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ data: RawAuditRow[] }> {
  const { data: recent } = await supabase
    .from('transaction_audit_log')
    .select('bulk_action_id, created_at')
    .not('bulk_action_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(2000)

  const ids: string[] = []
  for (const r of recent ?? []) {
    const id = String(r.bulk_action_id)
    if (!ids.includes(id)) ids.push(id)
    if (ids.length >= RECENT_ACTION_LIMIT) break
  }
  if (ids.length === 0) return { data: [] }

  const data = await fetchAllPages<RawAuditRow>(
    (from, to) =>
      supabase
        .from('transaction_audit_log')
        .select(
          'bulk_action_id, transaction_id, action, field, previous_value, new_value, created_at, reverted_at',
        )
        .in('bulk_action_id', ids)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to),
    'category-review recent audit entries',
  )
  return { data }
}

export async function getCategoryReviewData(): Promise<CategoryReviewData> {
  const supabase = await createClient()

  const [rows, decisionsRes, auditRes] = await Promise.all([
    fetchRows(),
    supabase
      .from('category_merge_proposals')
      .select(
        'id, from_categories, to_category, status, transaction_count, total_amount, bulk_action_id, decided_at, decided_by',
      )
      // Oldest first so a later decision on the same merge wins below.
      .order('created_at', { ascending: true }),
    fetchRecentAuditEntries(supabase),
  ])

  // Category usages from spend rows only.
  const usageMap = new Map<
    string,
    { value: string; count: number; total: number; vendors: Set<string> }
  >()
  type MistypedAcc = {
    category: string
    count: number
    amount: number
    transactionIds: string[]
    months: Set<string>
    /** Raw rows kept so the evidence test can judge direction and recurrence. */
    evidenceRows: EvidenceRow[]
    /** Descriptions kept so the corrective category can be named from the data. */
    descriptions: string[]
  }
  const mistypedMap = new Map<string, MistypedAcc>()

  // Live cash totals, computed from the same rows so the reclassification
  // preview is measured against what the reports actually show right now.
  let currentCashIn = 0
  let currentCashOut = 0
  for (const row of rows) {
    if (row.reviewStatus === 'excluded') continue
    const magnitude = Math.abs(Number(row.amount) || 0)
    const type = row.transactionType
    if (type === 'income') currentCashIn += magnitude
    else if (SPEND_TYPES.includes(type as never)) currentCashOut += magnitude
    else if (SPEND_OFFSET_TYPES.includes(type as never)) currentCashOut -= magnitude
  }

  for (const row of rows) {
    if (!isSpendRow(row)) continue
    const value = row.expenseCategory.trim()
    if (!value) continue

    const bucket =
      usageMap.get(value) ??
      { value, count: 0, total: 0, vendors: new Set<string>() }
    bucket.count += 1
    bucket.total += Math.abs(Number(row.amount) || 0)
    if (row.vendorId) bucket.vendors.add(row.vendorId)
    usageMap.set(value, bucket)

    if (INCOME_CATEGORY_HINTS.includes(value.toLowerCase())) {
      const m =
        mistypedMap.get(value) ??
        {
          category: value,
          count: 0,
          amount: 0,
          transactionIds: [],
          months: new Set<string>(),
          evidenceRows: [],
          descriptions: [],
        }
      m.descriptions.push(row.description)
      m.count += 1
      m.amount += Math.abs(Number(row.amount) || 0)
      m.transactionIds.push(row.id)
      if (row.transactionDate) m.months.add(row.transactionDate.slice(0, 7))
      // Direction comes from the imported type, not the sign: amounts are stored
      // as positive magnitudes, so a sign-based guess would invert every row.
      m.evidenceRows.push({
        amount: Math.abs(Number(row.amount) || 0),
        direction: row.transactionType === 'income' ? 'in' : 'out',
        date: row.transactionDate ?? '',
      })
      mistypedMap.set(value, m)
    }
  }

  const usages: CategoryUsage[] = [...usageMap.values()].map((b) => ({
    value: b.value,
    count: b.count,
    total: b.total,
    vendorCount: b.vendors.size,
  }))

  // Persisted decisions, keyed by signature. Rows arrive oldest-first, so the
  // last write for a signature is the current decision (approve → undo → ...).
  const priorStatus = new Map<string, MergeDecisionStatus>()
  const decisions: DecidedMerge[] = []
  for (const d of decisionsRes.data ?? []) {
    const fromCategories = ((d.from_categories ?? []) as string[]) ?? []
    const toCategory = String(d.to_category ?? '')
    const signature = proposalSignature(fromCategories, toCategory)
    const status = String(d.status ?? 'pending') as MergeDecisionStatus
    priorStatus.set(signature, status)
    decisions.push({
      id: String(d.id),
      signature,
      fromCategories,
      toCategory,
      status,
      transactionCount: Number(d.transaction_count ?? 0),
      totalAmount: Number(d.total_amount ?? 0),
      bulkActionId: d.bulk_action_id ? String(d.bulk_action_id) : null,
      decidedAt: d.decided_at ? String(d.decided_at) : null,
      decidedBy: d.decided_by ? String(d.decided_by) : null,
    })
  }

  const proposals: ReviewableMerge[] = proposeCategoryMerges(usages)
    .map((p) => {
      const signature = proposalSignature(p.fromCategories, p.toCategory)
      return { ...p, signature, priorStatus: priorStatus.get(signature) ?? null }
    })
    // Only genuinely undecided merges belong in the pending queue. Rejected and
    // undone merges must not nag, and approved ones are already grouped — but
    // they all stay visible on the status board via `decisions`.
    .filter((p) => p.priorStatus === null || p.priorStatus === 'pending')

  // CHECK review queue: bank lines that name no payee.
  const checkRows: CheckRow[] = rows
    .filter((r) => /^\s*CHECK\b/i.test(r.description))
    .map((r) => ({
      id: r.id,
      transactionDate: r.transactionDate,
      amount: r.amount,
      checkNumber: r.checkNumber ?? parseCheckNumber(r.description),
      description: r.description,
      accountName: r.accountName,
      expenseCategory: r.expenseCategory,
      vendorId: r.vendorId,
      reviewStatus: r.reviewStatus,
    }))
  const checkSummary = summarizeChecks(checkRows)

  // Audit history, collapsed to one entry per bulk action.
  //
  // `count` is the number of transactions the owner actually changed, so it is a
  // count of DISTINCT transaction ids — not of log entries. One write logs an
  // entry per changed field, so counting entries reported a 47-row correction as
  // "94 rows" and made a correct change look like it had hit twice as much data.
  const seenTx = new Map<string, Set<string>>()
  const byBulk = new Map<string, AuditEntry>()
  for (const a of auditRes.data ?? []) {
    const id = String(a.bulk_action_id)
    // Fall back to the entry's own identity when a legacy row has no
    // transaction_id, so it still counts once rather than vanishing.
    const txId = a.transaction_id ? String(a.transaction_id) : `entry:${a.created_at}:${a.field}`
    const existing = byBulk.get(id)
    if (existing) {
      const set = seenTx.get(id)!
      set.add(txId)
      existing.count = set.size
      // The action counts as undone only when every entry in it is undone.
      existing.reverted = existing.reverted && Boolean(a.reverted_at)
      // Prefer showing the category change over the review_status bookkeeping,
      // which is what the owner recognises.
      if (String(a.field ?? '') === 'expense_category') {
        existing.field = 'expense_category'
        existing.sampleFrom = a.previous_value ? String(a.previous_value) : null
        existing.sampleTo = a.new_value ? String(a.new_value) : null
      }
    } else {
      seenTx.set(id, new Set([txId]))
      byBulk.set(id, {
        bulkActionId: id,
        action: String(a.action ?? ''),
        field: String(a.field ?? ''),
        count: 1,
        sampleFrom: a.previous_value ? String(a.previous_value) : null,
        sampleTo: a.new_value ? String(a.new_value) : null,
        createdAt: String(a.created_at ?? ''),
        reverted: Boolean(a.reverted_at),
      })
    }
  }

  // Reclassifying a flagged group to income moves its dollars out of cash-out
  // and into cash-in, so the resulting totals are the current ones shifted by
  // exactly that group's amount.
  const mistyped: MistypedFlag[] = [...mistypedMap.values()]
    .sort((a, b) => b.amount - a.amount)
    .map((m) => {
      const evidence = assessReclassification(m.evidenceRows)
      // Only name a corrective category when the evidence actually says "fee".
      // For an `unclear` group there is nothing to correct toward yet, and
      // offering a confident label would defeat the point of the block.
      const merchant =
        evidence.verdict === 'likely_recurring_fee'
          ? deriveMerchantName(m.descriptions)
          : null
      return {
        category: m.category,
        count: m.count,
        amount: m.amount,
        transactionIds: m.transactionIds,
        months: [...m.months].sort(),
        resultingCashIn: currentCashIn + m.amount,
        resultingCashOut: currentCashOut - m.amount,
        evidence,
        suggestedExpenseCategory: merchant ? `${merchant} — Fees` : null,
      }
    })

  return {
    proposals,
    decisions,
    distinctSpendCategories: usages.length,
    checks: { ...checkSummary, transactionIds: checkRows.map((r) => r.id) },
    mistyped,
    recentActions: [...byBulk.values()].slice(0, 25),
    transactionCount: rows.length,
    currentCashIn,
    currentCashOut,
  }
}
