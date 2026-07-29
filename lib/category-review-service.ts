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

export type ReviewableMerge = MergeProposal & {
  signature: string
  /** Prior decision, when the owner has already acted on this exact merge. */
  priorStatus: 'pending' | 'approved' | 'rejected' | null
}

export type MistypedFlag = {
  category: string
  count: number
  amount: number
  transactionIds: string[]
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
  distinctSpendCategories: number
  checks: CheckReviewSummary & { transactionIds: string[] }
  /** Income-style categories sitting on spend rows — likely a mis-type. */
  mistyped: MistypedFlag[]
  recentActions: AuditEntry[]
  transactionCount: number
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
      .select('from_categories, to_category, status'),
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
  const mistypedMap = new Map<string, MistypedFlag>()

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
        { category: value, count: 0, amount: 0, transactionIds: [] }
      m.count += 1
      m.amount += Math.abs(Number(row.amount) || 0)
      m.transactionIds.push(row.id)
      mistypedMap.set(value, m)
    }
  }

  const usages: CategoryUsage[] = [...usageMap.values()].map((b) => ({
    value: b.value,
    count: b.count,
    total: b.total,
    vendorCount: b.vendors.size,
  }))

  // Persisted decisions, keyed by signature.
  const priorStatus = new Map<string, 'pending' | 'approved' | 'rejected'>()
  for (const d of decisionsRes.data ?? []) {
    const sig = proposalSignature(
      (d.from_categories ?? []) as string[],
      String(d.to_category ?? ''),
    )
    priorStatus.set(sig, d.status as 'pending' | 'approved' | 'rejected')
  }

  const proposals: ReviewableMerge[] = proposeCategoryMerges(usages)
    .map((p) => {
      const signature = proposalSignature(p.fromCategories, p.toCategory)
      return { ...p, signature, priorStatus: priorStatus.get(signature) ?? null }
    })
    // A merge the owner already rejected should not keep nagging.
    .filter((p) => p.priorStatus !== 'rejected')

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

  return {
    proposals,
    distinctSpendCategories: usages.length,
    checks: { ...checkSummary, transactionIds: checkRows.map((r) => r.id) },
    mistyped: [...mistypedMap.values()].sort((a, b) => b.amount - a.amount),
    recentActions: [...byBulk.values()].slice(0, 25),
    transactionCount: rows.length,
  }
}
