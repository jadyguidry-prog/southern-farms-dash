import { createClient } from '@/lib/supabase/server'
import {
  analyzeRecurring,
  cadenceToFrequency,
  SPEND_TYPES,
  SPEND_OFFSET_TYPES,
  type ReviewStatus,
  type TransactionType,
  type VendorMatchRule,
} from '@/lib/transactions'
import {
  buildPayeeGroups,
  type GroupInputRow,
  type PayeeGroup,
} from '@/lib/transaction-groups'
import { fetchAllPages } from '@/lib/paginate'

export type TransactionRow = {
  id: string
  transactionDate: string
  postedDate: string
  description: string
  normalizedDescription: string
  amount: number
  transactionType: TransactionType
  paymentMethod: string
  accountName: string
  vendorId: string | null
  vendorName: string
  expenseCategory: string
  isRecurring: boolean
  recurringConfidence: number | null
  reviewStatus: ReviewStatus
  sourceFileName: string
  notes: string
}

function mapTransaction(
  t: Record<string, any>,
  vendorNames: Map<string, string>,
): TransactionRow {
  const str = (k: string) => (t[k] == null ? '' : String(t[k]))
  const vendorId = t.vendor_id ? String(t.vendor_id) : null
  return {
    id: String(t.id),
    transactionDate: str('transaction_date'),
    postedDate: str('posted_date'),
    description: str('description'),
    normalizedDescription: str('normalized_description'),
    amount: Number(t.amount ?? 0),
    transactionType: (t.transaction_type ?? 'expense') as TransactionType,
    paymentMethod: str('payment_method'),
    accountName: str('account_name'),
    vendorId,
    vendorName: vendorId ? (vendorNames.get(vendorId) ?? '') : '',
    expenseCategory: str('expense_category'),
    isRecurring: Boolean(t.is_recurring),
    recurringConfidence:
      t.recurring_confidence == null ? null : Number(t.recurring_confidence),
    reviewStatus: (t.review_status ?? 'unreviewed') as ReviewStatus,
    sourceFileName: str('source_file_name'),
    notes: str('notes'),
  }
}

async function vendorNameMap(): Promise<Map<string, string>> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('vendors')
    .select('id, name, display_name')
    .is('deleted_at', null)
  const map = new Map<string, string>()
  for (const v of data ?? []) {
    map.set(String(v.id), String(v.display_name || v.name))
  }
  return map
}

export type TransactionFilters = {
  reviewStatus?: ReviewStatus | 'all'
  vendorId?: string | 'all' | 'unmatched'
  search?: string
  from?: string
  to?: string
  limit?: number
}

/**
 * Transactions for the review table. Soft-deleted rows are always excluded so a
 * removed transaction stops affecting vendor spend everywhere at once.
 */
export async function getTransactions(
  filters: TransactionFilters = {},
): Promise<TransactionRow[]> {
  const supabase = await createClient()
  let query = supabase
    .from('financial_transactions')
    .select('*')
    .is('deleted_at', null)
    .order('transaction_date', { ascending: false })
    .limit(filters.limit ?? 500)

  if (filters.reviewStatus && filters.reviewStatus !== 'all') {
    query = query.eq('review_status', filters.reviewStatus)
  }
  if (filters.vendorId === 'unmatched') {
    query = query.is('vendor_id', null)
  } else if (filters.vendorId && filters.vendorId !== 'all') {
    query = query.eq('vendor_id', filters.vendorId)
  }
  if (filters.from) query = query.gte('transaction_date', filters.from)
  if (filters.to) query = query.lte('transaction_date', filters.to)
  if (filters.search) {
    query = query.ilike('description', `%${filters.search}%`)
  }

  const [{ data }, names] = await Promise.all([query, vendorNameMap()])
  return (data ?? []).map((t) => mapTransaction(t, names))
}

/**
 * Fetch every row matching a review status, paging past PostgREST's 1000-row
 * cap. Grouping has to see the whole set — the review table's 500-row limit
 * would silently hide payees and understate their totals.
 */
async function fetchAllForGrouping(
  statuses: ReviewStatus[],
): Promise<Record<string, any>[]> {
  const supabase = await createClient()
  const pageSize = 1000
  const all: Record<string, any>[] = []

  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from('financial_transactions')
      .select(
        'id, transaction_date, description, normalized_description, amount, transaction_type, review_status, vendor_id, expense_category',
      )
      .is('deleted_at', null)
      .in('review_status', statuses)
      .order('id', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1)

    if (error) break
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < pageSize) break
  }

  return all
}

export type PayeeGroupsResult = {
  payeeGroups: PayeeGroup[]
  genericGroups: PayeeGroup[]
  /** Totals across everything still awaiting review. */
  totals: {
    groups: number
    transactions: number
    spend: number
  }
}

/**
 * Outstanding review work, collapsed into payee groups ordered by spend.
 *
 * Only rows that still need attention are grouped (`needs_review` and
 * `unreviewed`); already-matched and excluded rows are left alone so this view
 * is a work queue rather than a second copy of the full ledger.
 */
export async function getPayeeGroups(): Promise<PayeeGroupsResult> {
  const [rows, names] = await Promise.all([
    fetchAllForGrouping(['needs_review', 'unreviewed']),
    vendorNameMap(),
  ])

  const inputs: GroupInputRow[] = rows.map((t) => ({
    id: String(t.id),
    transactionDate: String(t.transaction_date ?? ''),
    description: String(t.description ?? ''),
    normalizedDescription: String(t.normalized_description ?? ''),
    amount: Number(t.amount ?? 0),
    transactionType: (t.transaction_type ?? 'expense') as TransactionType,
    reviewStatus: (t.review_status ?? 'unreviewed') as ReviewStatus,
    vendorId: t.vendor_id ? String(t.vendor_id) : null,
    expenseCategory: String(t.expense_category ?? ''),
  }))

  const groups = buildPayeeGroups(inputs)
  const payeeGroups = groups.filter((g) => !g.generic)
  const genericGroups = groups.filter((g) => g.generic)

  return {
    payeeGroups,
    genericGroups,
    totals: {
      groups: groups.length,
      transactions: inputs.length,
      spend: groups.reduce((sum, g) => sum + g.totalSpend, 0),
    },
  }
}

/** Vendor names keyed by id, for labelling suggested matches in the group view. */
export async function getVendorNameMap(): Promise<Record<string, string>> {
  const map = await vendorNameMap()
  return Object.fromEntries(map)
}

/**
 * Counts for the review dashboard.
 *
 * Every one of these is a count over the *whole* table, so the read must be
 * paginated. Unpaginated, PostgREST returned its first 1,000 rows and this
 * function reported 1,000 of 1,318 transactions with 832 of 995 unmatched —
 * telling the owner they were close to done while 318 rows stayed invisible.
 * Ordered by id so pages cannot overlap or skip.
 */
export async function getTransactionCounts() {
  const supabase = await createClient()
  const rows = await fetchAllPages<{
    review_status: string | null
    vendor_id: string | null
  }>(
    (from, to) =>
      supabase
        .from('financial_transactions')
        .select('review_status, vendor_id')
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    'getTransactionCounts',
  )

  return {
    total: rows.length,
    unreviewed: rows.filter((r) => r.review_status === 'unreviewed').length,
    needsReview: rows.filter((r) => r.review_status === 'needs_review').length,
    matched: rows.filter((r) => r.review_status === 'matched').length,
    excluded: rows.filter((r) => r.review_status === 'excluded').length,
    unmatched: rows.filter((r) => r.vendor_id == null).length,
  }
}

export async function getMatchRules(): Promise<VendorMatchRule[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('vendor_match_rules')
    .select('*')
    .eq('active', true)
    .order('priority', { ascending: true })
  return (data ?? []).map((r) => ({
    id: String(r.id),
    vendor_id: String(r.vendor_id),
    match_text: String(r.match_text),
    match_type: r.match_type,
    priority: Number(r.priority),
    active: Boolean(r.active),
  }))
}

export type VendorSpend = {
  vendorId: string
  totalSpend: number
  ytdSpend: number
  transactionCount: number
  averageAmount: number
  lastTransactionDate: string | null
  lastAmount: number | null
}

/**
 * Real spend per vendor, computed from imported transactions.
 *
 * Only `expense`/`fee`/`interest` count toward spend, and `refund`/`credit`
 * subtract from it. Card payments and transfers are ignored so paying off a
 * credit card doesn't double-count the purchases already on it. Excluded rows
 * are skipped entirely.
 */
export async function getVendorSpend(): Promise<Map<string, VendorSpend>> {
  const supabase = await createClient()
  // Paginated because this sums money. Only linked transactions match, so it
  // returns ~323 rows today and is under the cap — but 995 transactions are still
  // unlinked, and linking them is exactly what the vendor-matching screen is for.
  // Crossing 1,000 would quietly shrink every vendor total with no error.
  const data = await fetchAllPages<{
    vendor_id: string | null
    amount: number | null
    transaction_type: string | null
    transaction_date: string | null
  }>(
    (from, to) =>
      supabase
        .from('financial_transactions')
        .select('vendor_id, amount, transaction_type, transaction_date')
        .is('deleted_at', null)
        .not('vendor_id', 'is', null)
        .neq('review_status', 'excluded')
        // Date alone is not unique — many transactions share a day — so id breaks
        // ties and keeps paging stable.
        .order('transaction_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to),
    'getVendorSpend',
  )

  const yearStart = `${new Date().getFullYear()}-01-01`
  const map = new Map<string, VendorSpend>()

  for (const row of data) {
    const vendorId = String(row.vendor_id)
    const type = row.transaction_type as TransactionType
    const isSpend = SPEND_TYPES.includes(type)
    const isOffset = SPEND_OFFSET_TYPES.includes(type)
    if (!isSpend && !isOffset) continue

    const magnitude = Math.abs(Number(row.amount ?? 0))
    const signed = isSpend ? magnitude : -magnitude
    const date = String(row.transaction_date)

    const existing = map.get(vendorId) ?? {
      vendorId,
      totalSpend: 0,
      ytdSpend: 0,
      transactionCount: 0,
      averageAmount: 0,
      lastTransactionDate: null as string | null,
      lastAmount: null as number | null,
    }

    existing.totalSpend += signed
    if (date >= yearStart) existing.ytdSpend += signed
    existing.transactionCount += 1
    // Rows arrive newest-first, so the first one seen is the latest.
    if (existing.lastTransactionDate === null) {
      existing.lastTransactionDate = date
      existing.lastAmount = magnitude
    }
    map.set(vendorId, existing)
  }

  for (const spend of map.values()) {
    spend.averageAmount =
      spend.transactionCount > 0 ? spend.totalSpend / spend.transactionCount : 0
  }

  return map
}

export type RecurringSuggestion = {
  key: string
  vendorId: string
  vendorName: string
  normalizedDescription: string
  sampleDescription: string
  cadence: string
  frequency: string | null
  averageAmount: number
  occurrences: number
  confidence: number
  lastDate: string
  amountVariance: number
  alreadyTracked: boolean
}

/**
 * Detect recurring charges from imported history and surface them as
 * suggestions. Nothing is written to cash_obligations automatically — each
 * suggestion must be approved, because an unattended write would put an
 * unverified number into the cash-flow forecast.
 */
export async function getRecurringSuggestions(): Promise<RecurringSuggestion[]> {
  const supabase = await createClient()
  // Paginated: a missed page would drop occurrences of a recurring charge and
  // could make a genuine monthly obligation look irregular enough to ignore.
  const [data, names, { data: obligations }] = await Promise.all([
    fetchAllPages<Record<string, any>>(
      (from, to) =>
        supabase
          .from('financial_transactions')
          .select(
            'vendor_id, normalized_description, description, amount, transaction_date, transaction_type',
          )
          .is('deleted_at', null)
          .not('vendor_id', 'is', null)
          .neq('review_status', 'excluded')
          .order('transaction_date', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      'getRecurringSuggestions',
    ),
    vendorNameMap(),
    supabase.from('cash_obligations').select('vendor_name, name'),
  ])

  // Group by vendor + merchant string so two different charges from the same
  // vendor (e.g. fuel vs. equipment) are evaluated as separate patterns.
  const groups = new Map<
    string,
    {
      vendorId: string
      normalized: string
      sample: string
      samples: Array<{ transaction_date: string; amount: number }>
    }
  >()

  for (const row of data) {
    const type = row.transaction_type as TransactionType
    if (!SPEND_TYPES.includes(type)) continue
    const vendorId = String(row.vendor_id)
    const normalized = String(row.normalized_description ?? '')
    if (!normalized) continue

    const key = `${vendorId}::${normalized}`
    const group =
      groups.get(key) ??
      { vendorId, normalized, sample: String(row.description ?? ''), samples: [] }
    group.samples.push({
      transaction_date: String(row.transaction_date),
      amount: Number(row.amount ?? 0),
    })
    groups.set(key, group)
  }

  const tracked = new Set(
    (obligations ?? [])
      .map((o) => String(o.vendor_name ?? '').trim().toLowerCase())
      .filter(Boolean),
  )

  const suggestions: RecurringSuggestion[] = []
  for (const [key, group] of groups) {
    const analysis = analyzeRecurring(group.samples)
    if (!analysis.isRecurring || !analysis.cadence) continue

    const vendorName = names.get(group.vendorId) ?? ''
    const lastDate = group.samples
      .map((s) => s.transaction_date)
      .sort()
      .at(-1) as string

    suggestions.push({
      key,
      vendorId: group.vendorId,
      vendorName,
      normalizedDescription: group.normalized,
      sampleDescription: group.sample,
      cadence: analysis.cadence,
      frequency: cadenceToFrequency(analysis.cadence),
      averageAmount: analysis.averageAmount,
      occurrences: analysis.occurrences,
      confidence: analysis.confidence,
      lastDate,
      amountVariance: analysis.amountVariance,
      alreadyTracked: tracked.has(vendorName.trim().toLowerCase()),
    })
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence)
}

export async function getImportBatches() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('transaction_import_batches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(25)
  return (data ?? []).map((b) => ({
    id: String(b.id),
    fileName: String(b.file_name ?? ''),
    accountName: String(b.account_name ?? ''),
    rowCount: Number(b.row_count ?? 0),
    importedCount: Number(b.imported_count ?? 0),
    duplicateCount: Number(b.duplicate_count ?? 0),
    errorCount: Number(b.error_count ?? 0),
    status: String(b.status ?? 'pending'),
    createdAt: String(b.created_at ?? ''),
  }))
}

/** Distinct account names already imported, for the account picker. */
export async function getKnownAccountNames(): Promise<string[]> {
  const supabase = await createClient()
  // Paginated for correctness rather than urgency: the three known accounts all
  // appear within the first 1,000 rows today, so truncation happens to be
  // harmless here. It would stop being harmless the moment a new account is added
  // whose only transactions sort past the cap, and that failure would look like
  // the account simply not existing.
  const data = await fetchAllPages<{ account_name: string | null }>(
    (from, to) =>
      supabase
        .from('financial_transactions')
        .select('account_name')
        .not('account_name', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
    'getKnownAccountNames',
  )
  const set = new Set<string>()
  for (const row of data) {
    const name = String(row.account_name ?? '').trim()
    if (name) set.add(name)
  }
  return [...set].sort()
}
