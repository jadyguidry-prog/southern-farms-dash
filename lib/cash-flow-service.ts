// Cash-flow analysis derived from imported bank transactions.
//
// The pure functions here are deliberately DB-free so the money math can be
// unit tested without a database. Only `getCashFlowInsight` touches Supabase.

import { createClient } from '@/lib/supabase/server'
import {
  SPEND_TYPES,
  SPEND_OFFSET_TYPES,
  type ReviewStatus,
  type TransactionType,
} from '@/lib/transactions'
import {
  buildPayeeGroups,
  type GroupInputRow,
} from '@/lib/transaction-groups'

/* ------------------------------------------------------------------ */
/* Money direction                                                     */
/* ------------------------------------------------------------------ */

export type CashDirection = 'in' | 'out' | 'offset' | 'neutral'

/**
 * Which way a transaction moves cash for reporting purposes.
 *
 * `transfer` and `payment` are deliberately **neutral**, matching the existing
 * `getVendorSpend` semantics: moving money between your own accounts, or paying
 * off a card, would double-count purchases that are already recorded as
 * expenses. That excluded volume is reported rather than silently dropped —
 * see `excluded` on the returned summaries.
 *
 * `refund`/`credit` reduce outflow instead of adding inflow, so a returned
 * purchase nets against the spend it reverses.
 */
export function cashDirectionOf(type: TransactionType): CashDirection {
  if (type === 'income') return 'in'
  if (SPEND_TYPES.includes(type)) return 'out'
  if (SPEND_OFFSET_TYPES.includes(type)) return 'offset'
  return 'neutral'
}

export type CashFlowInputRow = {
  id: string
  transactionDate: string
  description: string
  normalizedDescription: string
  amount: number
  transactionType: TransactionType
  reviewStatus: ReviewStatus
  vendorId: string | null
  expenseCategory: string
  accountName: string
}

/** Rows that should never count: excluded by the owner. */
function isCountable(row: CashFlowInputRow): boolean {
  return row.reviewStatus !== 'excluded'
}

/* ------------------------------------------------------------------ */
/* Monthly series                                                      */
/* ------------------------------------------------------------------ */

export type MonthlyCashFlow = {
  /** Sortable `YYYY-MM`. */
  monthKey: string
  /** Compact axis label, e.g. `Jan '25`. */
  month: string
  year: number
  inflow: number
  outflow: number
  net: number
  /** Accounts that contributed rows this month. */
  accounts: string[]
  /**
   * False when the month has spending but no deposits at all — a strong signal
   * that only a card statement was imported and the depository account is
   * missing. Such a month must not be read as "earned nothing".
   */
  complete: boolean
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** `2025-06` -> `Jun '25`. Keeps the year visible so months can't be confused. */
export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-')
  const idx = Number(m) - 1
  const name = MONTH_NAMES[idx] ?? m
  return `${name} '${(y ?? '').slice(2)}`
}

export type MonthlyCashFlowResult = {
  series: MonthlyCashFlow[]
  latestMonth: MonthlyCashFlow | null
  /**
   * Newest month with both deposits and spending. Summary tiles use this so a
   * card-only month can't be reported as a catastrophic loss.
   */
  latestCompleteMonth: MonthlyCashFlow | null
  /** Months present but missing their deposit account. */
  incompleteMonths: string[]
  /** Calendar months inside the range with no transactions imported at all. */
  gapMonths: string[]
  /** Cash movement intentionally left out of the series, for transparency. */
  excluded: { transfersAndPayments: number; count: number }
}

/** Every `YYYY-MM` from start to end inclusive, used to spot missing months. */
function monthsBetween(startKey: string, endKey: string): string[] {
  const out: string[] = []
  let year = Number(startKey.slice(0, 4))
  let month = Number(startKey.slice(5, 7))
  for (let guard = 0; guard < 600; guard += 1) {
    const key = `${year}-${String(month).padStart(2, '0')}`
    out.push(key)
    if (key === endKey) break
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}

/**
 * Group transactions into a monthly inflow/outflow series.
 *
 * Bucketed on the real `YYYY-MM` from `transaction_date` and sorted by that
 * key, so December 2025 can never sort next to January 2025. The
 * `cash_flow_monthly` table cannot be used for this: it stores only a month
 * name with no year, so a multi-year series interleaves.
 */
export function deriveMonthlyCashFlow(
  rows: CashFlowInputRow[],
  options: { months?: number } = {},
): MonthlyCashFlowResult {
  const months = options.months ?? 12
  const buckets = new Map<
    string,
    MonthlyCashFlow & { accountSet: Set<string> }
  >()
  let excludedTotal = 0
  let excludedCount = 0

  for (const row of rows) {
    if (!isCountable(row)) continue
    const monthKey = String(row.transactionDate ?? '').slice(0, 7)
    // A row without a usable date cannot be placed on a timeline.
    if (!/^\d{4}-\d{2}$/.test(monthKey)) continue

    const magnitude = Math.abs(Number(row.amount) || 0)
    const direction = cashDirectionOf(row.transactionType)

    const bucket =
      buckets.get(monthKey) ??
      {
        monthKey,
        month: monthLabel(monthKey),
        year: Number(monthKey.slice(0, 4)),
        inflow: 0,
        outflow: 0,
        net: 0,
        accounts: [] as string[],
        complete: false,
        accountSet: new Set<string>(),
      }

    // Account coverage is tracked for every row, including transfers, because
    // it describes which statements were imported rather than the money math.
    const account = (row.accountName ?? '').trim()
    if (account) bucket.accountSet.add(account)
    buckets.set(monthKey, bucket)

    if (direction === 'neutral') {
      excludedTotal += magnitude
      excludedCount += 1
      continue
    }

    if (direction === 'in') bucket.inflow += magnitude
    else if (direction === 'out') bucket.outflow += magnitude
    else bucket.outflow -= magnitude // refund/credit reverses spend
  }

  const ordered = [...buckets.values()].sort((a, b) =>
    a.monthKey < b.monthKey ? -1 : a.monthKey > b.monthKey ? 1 : 0,
  )
  for (const b of ordered) {
    b.net = b.inflow - b.outflow
    b.accounts = [...b.accountSet].sort()
    // A month with spending but not a single deposit is missing its bank
    // statement; treating it as real would invent a month of pure loss.
    b.complete = b.inflow > 0
  }

  const full: MonthlyCashFlow[] = ordered.map(
    ({ accountSet: _accountSet, ...rest }) => rest,
  )
  const series = full.slice(-months)

  const gapMonths =
    full.length > 1
      ? monthsBetween(full[0].monthKey, full[full.length - 1].monthKey).filter(
          (key) => !buckets.has(key),
        )
      : []

  const complete = series.filter((m) => m.complete)

  return {
    series,
    latestMonth: series.length > 0 ? series[series.length - 1] : null,
    latestCompleteMonth: complete.length > 0 ? complete[complete.length - 1] : null,
    incompleteMonths: series.filter((m) => !m.complete).map((m) => m.monthKey),
    gapMonths,
    excluded: { transfersAndPayments: excludedTotal, count: excludedCount },
  }
}

/* ------------------------------------------------------------------ */
/* Outflows by payee                                                   */
/* ------------------------------------------------------------------ */

export type PayeeOutflow = {
  key: string
  payee: string
  amount: number
  count: number
  /** Share of total identified + unidentified outflow, 0-1. */
  share: number
  lastDate: string
  exampleDescriptions: string[]
}

export type OutflowsByPayee = {
  payees: PayeeOutflow[]
  /**
   * Spend the bank never attributed to a payee (`CHECK`, `WITHDRAWAL`, ...).
   * Kept separate because no rule can ever identify it, so folding it into the
   * ranking would invent a fictitious top vendor.
   */
  unidentified: { amount: number; count: number; share: number; groups: PayeeOutflow[] }
  totalOutflow: number
}

/**
 * Rank outflows by payee, reusing `buildPayeeGroups` so the same
 * generic-description handling and net-spend math applies here as in the
 * vendor review queue.
 */
export function summarizeOutflowsByPayee(
  rows: CashFlowInputRow[],
): OutflowsByPayee {
  const inputs: GroupInputRow[] = rows
    .filter(isCountable)
    .map((r) => ({
      id: r.id,
      transactionDate: r.transactionDate,
      description: r.description,
      normalizedDescription: r.normalizedDescription,
      amount: r.amount,
      transactionType: r.transactionType,
      reviewStatus: r.reviewStatus,
      vendorId: r.vendorId,
      expenseCategory: r.expenseCategory,
    }))

  const groups = buildPayeeGroups(inputs)
  // Only positive net spend is an outflow. A group that nets to zero or below
  // (fully refunded, or income-only) is not money going out.
  const spending = groups.filter((g) => g.totalSpend > 0)
  const totalOutflow = spending.reduce((s, g) => s + g.totalSpend, 0)

  const toOutflow = (g: (typeof spending)[number]): PayeeOutflow => ({
    key: g.key,
    payee: g.payee,
    amount: g.totalSpend,
    count: g.count,
    share: totalOutflow > 0 ? g.totalSpend / totalOutflow : 0,
    lastDate: g.lastDate,
    exampleDescriptions: g.exampleDescriptions,
  })

  const identified = spending.filter((g) => !g.generic).map(toOutflow)
  const genericGroups = spending.filter((g) => g.generic).map(toOutflow)
  const unidentifiedAmount = genericGroups.reduce((s, g) => s + g.amount, 0)

  return {
    payees: identified,
    unidentified: {
      amount: unidentifiedAmount,
      count: genericGroups.reduce((s, g) => s + g.count, 0),
      share: totalOutflow > 0 ? unidentifiedAmount / totalOutflow : 0,
      groups: genericGroups,
    },
    totalOutflow,
  }
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

export const UNCATEGORIZED = 'Uncategorized'

/**
 * Reporting-only merges for values that are the same bucket spelled differently.
 *
 * Applied at display time; the stored `expense_category` and `vendors.category`
 * values are never rewritten. Every entry below was taken from values actually
 * present in the data, not an invented taxonomy. Ambiguous pairs are NOT here —
 * see `CATEGORY_MERGE_SUGGESTIONS`.
 */
export const CATEGORY_ALIASES: Record<string, string> = {
  // Packaging, spelled three ways across transactions and vendors.
  'packaging': 'Packaging & Labels',
  'labels & packaging': 'Packaging & Labels',
  // Software.
  'software': 'Software & Communications',
  // Pest control.
  'pest control': 'Facilities & Pest Control',
  // Shipping.
  'shipping': 'Shipping & Postage',
  // Cost of goods, tracked as four separate product lines.
  'meat / cogs': 'COGS',
  'food / cogs': 'COGS',
  'inventory / cogs': 'COGS',
  'bakery / cogs': 'COGS',
}

/**
 * Pairs that look mergeable but mean different things depending on the owner's
 * intent. Surfaced in the UI as a question rather than merged automatically,
 * because collapsing them would change reported numbers without consent.
 */
export const CATEGORY_MERGE_SUGGESTIONS: { values: string[]; note: string }[] = [
  {
    values: ['Equipment & Supplies', 'Equipment & Technology'],
    note: 'Both cover equipment but may separate physical supplies from technology.',
  },
  {
    values: ['Operating Supplies', 'General Supplies', 'Processing Supplies'],
    note: 'Three supply buckets that may or may not be the same spend.',
  },
]

/** Canonical display name for a stored category value. */
export function canonicalCategory(raw: string): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return UNCATEGORIZED
  return CATEGORY_ALIASES[trimmed.toLowerCase()] ?? trimmed
}

/**
 * Resolve a transaction's spending category.
 *
 * Order is the exception model the owner asked for: a per-transaction value
 * always wins, otherwise the vendor's default applies (so categorising a vendor
 * once carries to its future transactions), otherwise Uncategorized.
 */
export function resolveExpenseCategory(
  row: Pick<CashFlowInputRow, 'expenseCategory' | 'vendorId'>,
  vendorCategories: Map<string, string>,
): { category: string; source: 'transaction' | 'vendor' | 'none' } {
  const own = (row.expenseCategory ?? '').trim()
  if (own) return { category: canonicalCategory(own), source: 'transaction' }

  const vendorCat = row.vendorId
    ? (vendorCategories.get(row.vendorId) ?? '').trim()
    : ''
  if (vendorCat) return { category: canonicalCategory(vendorCat), source: 'vendor' }

  return { category: UNCATEGORIZED, source: 'none' }
}

export type CategorySpend = {
  category: string
  amount: number
  count: number
  share: number
  /** Raw stored values that were merged into this row, when more than one. */
  mergedFrom: string[]
}

export type SpendByCategory = {
  categories: CategorySpend[]
  totalSpend: number
  categorizedSpend: number
  uncategorizedSpend: number
  /** Coverage measured in dollars, which is far more honest than row counts. */
  coverage: number
  /**
   * Income-style categories found on spend rows — a data-quality signal, not a
   * real expense bucket. Surfaced so the owner can fix the transaction type.
   */
  suspectedMistyped: { category: string; amount: number; count: number }[]
}

/** Categories that describe money coming in; an expense row carrying one is a typo. */
const INCOME_CATEGORY_HINTS = ['sales deposit', 'loan proceeds', 'deposit', 'income']

/**
 * Spend grouped by resolved category.
 *
 * Membership is decided by **transaction type**, never by the category label —
 * `Sales Deposit` alone accounts for $443k of income, and grouping on the label
 * would put it at the top of a "where did my money go" chart.
 */
export function summarizeSpendByCategory(
  rows: CashFlowInputRow[],
  vendorCategories: Map<string, string>,
): SpendByCategory {
  const buckets = new Map<
    string,
    { amount: number; count: number; rawValues: Set<string> }
  >()
  const mistyped = new Map<string, { amount: number; count: number }>()

  for (const row of rows) {
    if (!isCountable(row)) continue
    const direction = cashDirectionOf(row.transactionType)
    if (direction !== 'out' && direction !== 'offset') continue

    const magnitude = Math.abs(Number(row.amount) || 0)
    const signed = direction === 'out' ? magnitude : -magnitude
    const { category } = resolveExpenseCategory(row, vendorCategories)

    const raw = (row.expenseCategory ?? '').trim()
    if (raw && INCOME_CATEGORY_HINTS.includes(raw.toLowerCase())) {
      const m = mistyped.get(raw) ?? { amount: 0, count: 0 }
      m.amount += magnitude
      m.count += 1
      mistyped.set(raw, m)
    }

    const bucket = buckets.get(category) ?? {
      amount: 0,
      count: 0,
      rawValues: new Set<string>(),
    }
    bucket.amount += signed
    bucket.count += 1
    if (raw) bucket.rawValues.add(raw)
    buckets.set(category, bucket)
  }

  const totalSpend = [...buckets.values()].reduce((s, b) => s + b.amount, 0)
  const uncategorizedSpend = buckets.get(UNCATEGORIZED)?.amount ?? 0

  const categories: CategorySpend[] = [...buckets.entries()]
    .map(([category, b]) => ({
      category,
      amount: b.amount,
      count: b.count,
      share: totalSpend > 0 ? b.amount / totalSpend : 0,
      mergedFrom: b.rawValues.size > 1 ? [...b.rawValues].sort() : [],
    }))
    .sort((a, b) => b.amount - a.amount)

  return {
    categories,
    totalSpend,
    categorizedSpend: totalSpend - uncategorizedSpend,
    uncategorizedSpend,
    coverage: totalSpend > 0 ? (totalSpend - uncategorizedSpend) / totalSpend : 0,
    suspectedMistyped: [...mistyped.entries()]
      .map(([category, m]) => ({ category, ...m }))
      .sort((a, b) => b.amount - a.amount),
  }
}

/* ------------------------------------------------------------------ */
/* Data access                                                         */
/* ------------------------------------------------------------------ */

const PAGE_SIZE = 1000

/**
 * Read every transaction, paging past PostgREST's silent 1000-row cap.
 *
 * There are already ~1,318 transactions, so an unpaginated read would quietly
 * drop the overflow and understate every total on the page — the same failure
 * that produced two weeks of revenue from two years of Square orders.
 */
async function fetchAllTransactions(): Promise<CashFlowInputRow[]> {
  const supabase = await createClient()
  const out: CashFlowInputRow[] = []

  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from('financial_transactions')
      .select(
        'id, transaction_date, description, normalized_description, amount, transaction_type, review_status, vendor_id, expense_category, account_name',
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
        normalizedDescription: String(t.normalized_description ?? ''),
        amount: Number(t.amount ?? 0),
        transactionType: (t.transaction_type ?? 'expense') as TransactionType,
        reviewStatus: (t.review_status ?? 'unreviewed') as ReviewStatus,
        vendorId: t.vendor_id ? String(t.vendor_id) : null,
        expenseCategory: String(t.expense_category ?? ''),
        accountName: String(t.account_name ?? ''),
      })),
    )
    if (rows.length < PAGE_SIZE) break
  }

  return out
}

/** Vendor default categories, keyed by vendor id. */
async function fetchVendorCategories(): Promise<Map<string, string>> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('vendors')
    .select('id, category')
    .is('deleted_at', null)

  const map = new Map<string, string>()
  for (const v of data ?? []) {
    const category = String(v.category ?? '').trim()
    if (category) map.set(String(v.id), category)
  }
  return map
}

export type CashFlowInsight = {
  monthly: MonthlyCashFlowResult
  outflows: OutflowsByPayee
  spendByCategory: SpendByCategory
  transactionCount: number
  /** Earliest and latest dates covered, so the page can state its own range. */
  dateRange: { from: string; to: string } | null
}

/**
 * Everything the cash-flow page needs, derived from imported transactions.
 * Returns empty structures rather than throwing when nothing is imported, so
 * the page can show an honest empty state instead of an error.
 */
export async function getCashFlowInsight(): Promise<CashFlowInsight> {
  const [rows, vendorCategories] = await Promise.all([
    fetchAllTransactions(),
    fetchVendorCategories(),
  ])

  const dates = rows
    .map((r) => r.transactionDate)
    .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort()

  return {
    monthly: deriveMonthlyCashFlow(rows),
    outflows: summarizeOutflowsByPayee(rows),
    spendByCategory: summarizeSpendByCategory(rows, vendorCategories),
    transactionCount: rows.length,
    dateRange:
      dates.length > 0
        ? { from: dates[0].slice(0, 10), to: dates[dates.length - 1].slice(0, 10) }
        : null,
  }
}
