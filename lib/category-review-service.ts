// Server-side loader for the Category Review screen.
//
// Pulls the live transaction data, runs the DB-free proposal/check logic in
// `lib/categories` and `lib/check-review`, and folds in decisions the owner has
// already persisted so nothing is proposed twice. Nothing here writes — writes
// live in `app/category-review/actions.ts`.

import { createClient } from '@/lib/supabase/server'
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

/** Income-style labels that should never sit on an expense row. */
const INCOME_CATEGORY_HINTS = ['sales deposit', 'loan proceeds', 'deposit', 'income']

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
    supabase
      .from('transaction_audit_log')
      .select('bulk_action_id, action, field, previous_value, new_value, created_at, reverted_at')
      .not('bulk_action_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500),
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
        }
      m.count += 1
      m.amount += Math.abs(Number(row.amount) || 0)
      m.transactionIds.push(row.id)
      if (row.transactionDate) m.months.add(row.transactionDate.slice(0, 7))
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
  const byBulk = new Map<string, AuditEntry>()
  for (const a of auditRes.data ?? []) {
    const id = String(a.bulk_action_id)
    const existing = byBulk.get(id)
    if (existing) {
      existing.count += 1
      existing.reverted = existing.reverted && Boolean(a.reverted_at)
    } else {
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
    .map((m) => ({
      category: m.category,
      count: m.count,
      amount: m.amount,
      transactionIds: m.transactionIds,
      months: [...m.months].sort(),
      resultingCashIn: currentCashIn + m.amount,
      resultingCashOut: currentCashOut - m.amount,
    }))

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
