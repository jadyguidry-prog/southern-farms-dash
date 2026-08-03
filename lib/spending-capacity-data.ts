/**
 * Live data loading for spending capacity.
 *
 * Kept separate from `spending-capacity-service.ts` on purpose: that module is
 * pure and unit-tested with no database, and this one is the only place that
 * touches Supabase. The split also keeps server-only imports out of any bundle
 * that a client component might pull the maths into.
 */
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { fetchAllPages } from '@/lib/paginate'
import { getBusinessSettings, getCashDebtSummary } from '@/lib/queries'
import { getObligationPayments, type ObligationPayment } from '@/lib/bill-pay-service'
import {
  addDays,
  assessConfidence,
  buildDayOfWeekProfile,
  buildWeeklyFlows,
  deriveSpendingCapacity,
  estimateWeeklyFlow,
  formatDate,
  isoDayOfWeek,
  parseDate,
  type CapacityConfidence,
  type CapacityResult,
  type DatedOutflow,
  type FlowEstimate,
  type LedgerRow,
} from '@/lib/spending-capacity-service'

/** Round to cents, mirroring the engine so the two layers cannot drift. */
function money(n: number) {
  return Math.round(n * 100) / 100
}

export type SpendingCapacity = CapacityResult & {
  confidence: CapacityConfidence
  estimate: FlowEstimate
  cashOnHand: number
  minCashReserve: number
  /** 30-day series for the existing forecast chart. */
  thirtyDay: { day: string; balance: number; cautious: number }[]
  /** Which accounts were treated as spendable cash, for the UI to disclose. */
  operatingAccounts: string[]
  lastLedgerDate: string
}

/**
 * Assemble the spending-capacity view from live records.
 *
 * Deliberate choices, each one load-bearing:
 * - Credit cards are excluded from operating cash. A card purchase is not cash
 *   leaving; counting it and its later payoff double-counts the same spend.
 * - Starts from RAW bank balance, then subtracts outstanding checks and pending
 *   drafts on their own dates. Starting from a figure that already nets them out
 *   would charge every uncleared payment twice.
 * - Vendors that appear as dated items are removed from the estimated baseline
 *   for the same reason.
 */
export const getSpendingCapacity = cache(async (): Promise<SpendingCapacity> => {
  const supabase = await createClient()
  const today = formatDate(new Date())

  const [{ data: accounts }, settings, summary, payments] = await Promise.all([
    supabase.from('bank_accounts').select('account_name, account_type, current_balance'),
    getBusinessSettings(),
    getCashDebtSummary(),
    getObligationPayments().catch((err) => {
      // Bill Pay is optional. Losing it must degrade the explanation, not the number.
      console.log('[v0] getSpendingCapacity: obligation payments unavailable:', err)
      return [] as ObligationPayment[]
    }),
  ])

  // Only accounts that hold spendable cash. A line of credit is borrowing capacity,
  // not money in hand, so it must never inflate what is safe to spend.
  const operating = (accounts ?? []).filter(
    (a) => !/credit|loan|card/i.test(`${a.account_type ?? ''} ${a.account_name ?? ''}`),
  )
  const cashOnHand = money(
    operating.reduce((s, a) => s + Number(a.current_balance ?? 0), 0),
  )

  // The ledger labels accounts by bank name while `bank_accounts` uses friendly
  // names, so resolve the ledger's own labels rather than assuming they match.
  type LedgerQueryRow = {
    transaction_date: string | null
    description: string | null
    amount: number | string | null
    transaction_type: string | null
    account_name: string | null
  }

  // Paginated: PostgREST silently caps responses at 1,000 rows, and a truncated
  // history would quietly bias every median computed below.
  const ledgerRows = await fetchAllPages<LedgerQueryRow>(
    (from, to) =>
      supabase
        .from('financial_transactions')
        .select('transaction_date, description, amount, transaction_type, account_name')
        .is('deleted_at', null)
        .not('account_name', 'is', null)
        .order('transaction_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    'getSpendingCapacity ledger',
  )

  const rows: LedgerRow[] = (ledgerRows ?? []).map((r) => ({
    date: String(r.transaction_date ?? '').slice(0, 10),
    description: r.description ?? '',
    amount: Number(r.amount ?? 0),
    type: r.transaction_type ?? '',
    accountName: r.account_name ?? '',
  }))

  const operatingAccounts = [
    ...new Set(
      rows
        .map((r) => r.accountName)
        .filter((n) => n && !/amex|american express|credit|card|loan/i.test(n)),
    ),
  ]

  const lastLedgerDate = rows.reduce((max, r) => (r.date > max ? r.date : max), '')

  // ---- dated outflows ----
  const datedOutflows: DatedOutflow[] = []

  const outstanding = payments.filter((p) => p.status === 'outstanding' && p.amount > 0)

  // An obligation that ALREADY has a payment written against it must not also be
  // charged on its due date. The written payment is the more concrete fact, and
  // counting both would double-charge the same bill against spendable cash.
  const coveredObligationIds = new Set(
    outstanding.map((p) => p.obligationId).filter((id): id is string => Boolean(id)),
  )

  const obligationLabels = new Map<string, string>()
  for (const o of summary.scheduledObligations) {
    const label = o.vendorName || o.obligationName || 'Scheduled obligation'
    if (o.id) obligationLabels.set(String(o.id), label)
    if (!o.effectiveDueDate || o.amount <= 0) continue
    if (o.id && coveredObligationIds.has(String(o.id))) continue
    datedOutflows.push({ date: o.effectiveDueDate, amount: Number(o.amount), label })
  }

  // Written checks and logged ACH drafts that have not cleared. This is real
  // committed money that the bank balance does not yet reflect.
  for (const p of outstanding) {
    const name =
      p.payeeName ||
      (p.obligationId ? obligationLabels.get(String(p.obligationId)) : '') ||
      'Uncleared payment'
    datedOutflows.push({
      date: p.paymentDate,
      amount: Number(p.amount),
      label: p.checkNumber ? `${name} (check ${p.checkNumber})` : name,
    })
  }

  // ---- baseline, with dated vendors removed so nothing is charged twice ----
  const windowEnd = addDays(today, 7)
  const excludeMatchers = [
    ...new Set(
      datedOutflows
        .filter((d) => d.date >= today && d.date <= windowEnd)
        .map((d) => d.label.replace(/\s*\(check[^)]*\)/i, '').trim())
        .filter((l) => l.length >= 3),
    ),
  ]

  const weeks = buildWeeklyFlows(rows, { operatingAccounts, today, excludeMatchers })
  const estimate = estimateWeeklyFlow(weeks)
  const { shares, hasProfile } = buildDayOfWeekProfile(rows, { operatingAccounts })

  const result = deriveSpendingCapacity({
    cashOnHand,
    minCashReserve: settings.min_cash_reserve,
    today,
    estimate,
    shares,
    datedOutflows,
    baselineWeeklyOutflow: estimate.typicalOutflow,
  })

  const confidence = assessConfidence({
    weeksObserved: estimate.weeksObserved,
    hasProfile,
    lastLedgerDate,
    today,
  })

  // ---- 30-day series for the existing chart ----
  const datedByDay = new Map<string, number>()
  for (const d of datedOutflows) {
    if (!d.date || d.amount <= 0) continue
    const key = d.date < today ? today : d.date
    if (key > addDays(today, 30)) continue
    datedByDay.set(key, (datedByDay.get(key) ?? 0) + d.amount)
  }

  const baselineDaily = estimate.typicalOutflow > 0 ? estimate.typicalOutflow / 7 : 0
  let typical = cashOnHand
  let cautious = cashOnHand
  const thirtyDay: SpendingCapacity['thirtyDay'] = []
  for (let i = 0; i < 30; i++) {
    const date = addDays(today, i)
    const share = shares[isoDayOfWeek(date)] ?? 0
    const out = (datedByDay.get(date) ?? 0) + baselineDaily
    typical = money(typical + estimate.typicalInflow * share - out)
    cautious = money(cautious + estimate.cautiousInflow * share - out)
    thirtyDay.push({
      day: parseDate(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      balance: typical,
      cautious,
    })
  }

  return {
    ...result,
    confidence,
    estimate,
    cashOnHand,
    minCashReserve: settings.min_cash_reserve,
    thirtyDay,
    operatingAccounts,
    lastLedgerDate,
  }
})
