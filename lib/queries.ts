import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import {
  cashReserveHealth,
  payrollHealth,
  weeklySalesHealth,
  compositeHealth,
  generateInsights,
  resolveNextDueDate,
} from '@/lib/health'
import {
  getMarketingAffordability,
} from '@/lib/marketing-affordability-service'
import {
  getSquareDailySales,
  computeWeeklySales,
  computeWeekToDateSales,
  computeMonthlySales,
  summarizeDailyRows,
} from '@/lib/square-sales-service'
import { getCashFlowInsight } from '@/lib/cash-flow-service'
import { getGrowthPlannerSnapshot } from '@/lib/growth-planner-service'
import { getSavedProposalReviews } from '@/lib/growth-proposal-review'
import { getCardExposure } from '@/lib/card-exposure-service'
import { CARD_ACCOUNT_TYPE, CREDIT_ACCOUNT_TYPES } from '@/lib/card-safety'
import { getBillReminders } from '@/lib/bill-reminders-service'
import type { BillReminderResult } from '@/lib/bill-reminders'
import type { BillsInsightInput } from '@/lib/health'
import { getLaborHealthSnapshot } from '@/lib/labor-service'
import { getCheckResolutionSnapshot } from '@/lib/check-resolution-service'
import { getOutstandingCheckSummary, getBillPaySnapshot } from '@/lib/bill-pay-service'
import { getSpendingCapacity } from '@/lib/spending-capacity-data'

// ---------- Types ----------
export type KpiRow = {
  key: string
  label: string | null
  value: number
  change: number | null
  trend: string | null
  meta: Record<string, number | string>
}

export type Kpis = Record<
  string,
  {
    value: number
    change: number | null
    trend: string | null
    label: string | null
    meta: Record<string, number | string>
  }
>

// Fallback KPI values so the dashboard never renders empty numbers if a
// particular metric hasn't been entered yet.
const KPI_FALLBACK = {
  value: 0,
  change: null as number | null,
  trend: null as string | null,
  label: null as string | null,
  meta: {} as Record<string, number | string>,
}

// ---------- Business settings ----------
// Operating targets entered by the owner (Admin → Business Settings).
// Defaults are used only when a setting row hasn't been created yet.
export const SETTING_DEFAULTS = {
  target_payroll_pct: 15,
  warning_payroll_pct: 16,
  // Gross margin target. Was previously read from a `grossProfitPct` KPI row's
  // meta with a literal 38 fallback — and that KPI row does not exist, so the
  // literal was always what was used. Now an owner-editable setting.
  target_gross_profit_pct: 38,
  min_cash_reserve: 15000,
  preferred_weekly_sales: 18000,
  minimum_weekly_sales: 17000,
  avg_monthly_wholesale: 6000,
  // Marketing Affordability engine knobs. Seeded as real rows by migration
  // `marketing_affordability_settings`; these mirrors exist only so a fresh
  // database still returns a number instead of `undefined`.
  marketing_baseline_pct: 1.5,
  marketing_ceiling_pct: 3,
  days_cash_target: 30,
  // How many days a hand-entered account balance stays trustworthy. Past this, the
  // Growth Planner still answers but reports the age and lowers its confidence.
  // Seeded as a real row by migration `card_staleness_setting`; this mirror exists
  // only so a fresh database returns a number instead of `undefined`.
  account_data_stale_days: 14,
  // How many days before its due date a bill starts appearing in reminders. Seeded as a
  // real row by migration `bill_reminders_and_self_scheduled`; this mirror exists both to
  // guard a fresh database AND because getBusinessSettings only surfaces keys present
  // here — without it the Settings field would render blank and never save.
  bill_reminder_lead_days: 3,
  // How far ahead the cash forecast projects when hunting for the low point. Must be long
  // enough to contain a card statement due date (~15 days out here) — a known payment
  // beyond the last projected day is invisible however large it is. Seeded as a real row
  // by migration `card_payment_forecast`; this mirror only guards a fresh database.
  cash_forecast_horizon_days: 30,
  // The shorter window the "safe to spend" headline is solved against. Deliberately not
  // the same as the horizon: spending is a decision about now, while the reserve warning
  // looks across the whole horizon.
  cash_near_term_days: 7,
} as const

export type SettingKey = keyof typeof SETTING_DEFAULTS
export type BusinessSettings = Record<SettingKey, number> & {
  rows: { key: string; label: string; value: number; unit: string; notes: string }[]
}

export async function getBusinessSettings(): Promise<BusinessSettings> {
  const supabase = await createClient()
  const { data } = await supabase.from('business_settings').select('*')

  const values = { ...SETTING_DEFAULTS } as Record<SettingKey, number>
  const rows: BusinessSettings['rows'] = []

  for (const row of data ?? []) {
    rows.push({
      key: row.setting_key,
      label: row.label,
      value: Number(row.value),
      unit: row.unit ?? 'number',
      notes: row.notes ?? '',
    })
    if (row.setting_key in values) {
      values[row.setting_key as SettingKey] = Number(row.value)
    }
  }

  return { ...values, rows }
}

export async function getKpis(): Promise<Kpis> {
  const supabase = await createClient()
  const { data } = await supabase.from('kpis').select('*')
  const map: Kpis = {}
  for (const row of (data ?? []) as KpiRow[]) {
    map[row.key] = {
      value: Number(row.value),
      change: row.change,
      trend: row.trend,
      label: row.label,
      meta: row.meta ?? {},
    }
  }
  return map
}

export function kpi(kpis: Kpis, key: string) {
  return kpis[key] ?? KPI_FALLBACK
}

export function asTrend(v: string | null): 'up' | 'down' | undefined {
  return v === 'up' || v === 'down' ? v : undefined
}

/*
 * The 30-day cash projection used to live here as `getCashForecast`. It has been
 * replaced by `getSpendingCapacity` in lib/spending-capacity-data.ts.
 *
 * Why it was removed rather than kept: its only source of incoming money was
 * unpaid receivables, of which this business has 2 totalling $761. Meanwhile it
 * subtracted every scheduled obligation, so the projected line could only ever
 * fall — it never counted the ~$13,095 a week that actually lands in the bank
 * from daily sales. The replacement derives inflows from the deposit history
 * itself, and is checked against the real balance by
 * scripts/verify-cash-reconciliation.ts.
 *
 * Receivables are deliberately NOT added on top of that: when an invoice is
 * paid it arrives as a bank deposit, which the deposit history already
 * reflects. Counting both would double-count the same money.
 *
 * The version deleted here had been extended (on the cash-flow branch) to also
 * include outstanding payments via `buildForecastMovements`, because omitting
 * them made the line look deceptively flat. That concern is NOT lost:
 * `getSpendingCapacity` reads `getObligationPayments` itself and subtracts
 * outstanding checks and pending ACH drafts from the raw bank balance. Both
 * fixes therefore survive, but only the deposit-derived version is reachable —
 * do not resurrect the receivables-only forecast.
 */

export async function getCashAccounts() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('cash_accounts')
    .select('*')
    .order('created_at', { ascending: true })
  return (data ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    bank: a.bank ?? '',
    balance: Number(a.balance),
  }))
}

export async function getCashFlowMonthly() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('cash_flow_monthly')
    .select('*')
    .order('month_order', { ascending: true })
  return (data ?? []).map((m) => ({
    month: m.month,
    inflow: Number(m.inflow),
    outflow: Number(m.outflow),
  }))
}

export async function getSalesMonthly() {
  const supabase = await createClient()
  // Order by year first: with more than one year of data, sorting by
  // month_order alone interleaves months from different years on the chart.
  const { data } = await supabase
    .from('sales_monthly')
    .select('*')
    .order('year', { ascending: true, nullsFirst: true })
    .order('month_order', { ascending: true })
  return (data ?? []).map((m) => ({
    month: m.month,
    wholesale: Number(m.wholesale),
    retail: Number(m.retail),
  }))
}

export async function getSalesByProduct() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('sales_by_product')
    .select('*')
    .order('revenue', { ascending: false })
  return (data ?? []).map((p) => ({ product: p.product, revenue: Number(p.revenue) }))
}

export async function getInventory() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('inventory')
    .select('*')
    .order('value', { ascending: false })
  return (data ?? []).map((i) => ({
    id: i.id,
    sku: i.sku,
    item: i.item,
    category: i.category ?? '',
    units: Number(i.units),
    value: Number(i.value),
    turnover: i.turnover ?? 'Medium',
    daysOnHand: Number(i.days_on_hand),
  }))
}

export async function getPayrollTrend() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('payroll_trend')
    .select('*')
    .order('month_order', { ascending: true })
  return (data ?? []).map((p) => ({
    month: p.month,
    payroll: Number(p.payroll),
    sales: Number(p.sales),
  }))
}

export async function getDepartments() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('departments')
    .select('*')
    .order('monthly_cost', { ascending: false })
  return (data ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    employees: Number(d.employees),
    monthlyCost: Number(d.monthly_cost),
  }))
}

/**
 * Accounts-payable view of vendors, used by the Payables tab. Soft-deleted
 * vendors are excluded so removing a vendor also clears it from payables.
 */
export async function getVendors() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('vendors')
    .select('*')
    .is('deleted_at', null)
    .order('due_date', { ascending: true })
  return (data ?? []).map((v) => ({
    id: v.id,
    name: v.name,
    category: v.category ?? '',
    balance: Number(v.balance ?? 0),
    due: v.due_date ?? '',
    status: v.status ?? 'Upcoming',
  }))
}

export type DirectoryVendor = {
  id: string
  vendorNumber: string
  name: string
  displayName: string
  category: string
  vendorType: string
  vendorStatus: string
  phone: string
  email: string
  website: string
  billingAddress: string
  shippingAddress: string
  paymentTerms: string
  preferredPaymentMethod: string
  notes: string
  recurring: boolean
  requires1099: boolean
  archived: boolean
  balance: number
  createdAt: string
  updatedAt: string
}

function mapDirectoryVendor(v: Record<string, unknown>): DirectoryVendor {
  const str = (k: string) => (v[k] == null ? '' : String(v[k]))
  return {
    id: String(v.id),
    vendorNumber: str('vendor_number'),
    name: str('name'),
    displayName: str('display_name') || str('name'),
    category: str('category'),
    vendorType: str('vendor_type'),
    vendorStatus: str('vendor_status') || 'Active',
    phone: str('phone'),
    email: str('email'),
    website: str('website'),
    billingAddress: str('billing_address'),
    shippingAddress: str('shipping_address'),
    paymentTerms: str('payment_terms'),
    preferredPaymentMethod: str('preferred_payment_method'),
    notes: str('notes'),
    recurring: Boolean(v.recurring),
    requires1099: Boolean(v.requires_1099),
    archived: v.archived_at != null,
    balance: Number(v.balance ?? 0),
    createdAt: str('created_at'),
    updatedAt: str('updated_at'),
  }
}

/**
 * The vendor directory. Returns every vendor that has not been soft-deleted,
 * including archived ones, so the page can offer an "Archived" filter.
 */
export async function getVendorDirectory(): Promise<DirectoryVendor[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('vendors')
    .select('*')
    .is('deleted_at', null)
    .order('name', { ascending: true })
  return (data ?? []).map(mapDirectoryVendor)
}

/**
 * A single vendor with its contacts and documents. Returns null when the id
 * doesn't exist or the vendor has been soft-deleted.
 */
export async function getVendorDetail(id: string) {
  const supabase = await createClient()
  const [{ data: vendor }, { data: contacts }, { data: documents }] =
    await Promise.all([
      supabase
        .from('vendors')
        .select('*')
        .eq('id', id)
        .is('deleted_at', null)
        .maybeSingle(),
      supabase
        .from('vendor_contacts')
        .select('*')
        .eq('vendor_id', id)
        .order('created_at', { ascending: true }),
      supabase
        .from('vendor_documents')
        .select('*')
        .eq('vendor_id', id)
        .order('uploaded_at', { ascending: false }),
    ])

  if (!vendor) return null

  return {
    vendor: mapDirectoryVendor(vendor),
    contacts: (contacts ?? []).map((c) => ({
      id: String(c.id),
      name: c.name ?? '',
      title: c.title ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
    })),
    documents: (documents ?? []).map((d) => ({
      id: String(d.id),
      documentName: d.document_name ?? '',
      documentType: d.document_type ?? '',
      fileUrl: d.file_url ?? '',
      uploadedAt: d.uploaded_at ?? '',
    })),
  }
}

/**
 * Recurring cash obligations already recorded against this vendor. Obligations
 * reference a vendor by name, so we match on both the legal and display name.
 * Nothing is estimated — an empty list simply means no obligation has been
 * entered for this vendor yet.
 */
export async function getVendorObligations(names: string[]) {
  const wanted = names.map((n) => n.trim().toLowerCase()).filter(Boolean)
  if (wanted.length === 0) return []

  const obligations = await getCashObligations()
  return obligations.filter((o) =>
    wanted.includes((o.vendorName ?? '').trim().toLowerCase()),
  )
}

export async function getWholesaleCustomers() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('wholesale_customers')
    .select('*')
    .order('ytd', { ascending: false })
  return (data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    region: c.region ?? '',
    ytd: Number(c.ytd),
    outstanding: Number(c.outstanding),
    terms: c.terms ?? '',
    status: c.status ?? 'Current',
  }))
}

export async function getLoans() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('loans')
    .select('*')
    .order('current_balance', { ascending: false })
  return (data ?? []).map((l) => ({
    id: l.id,
    name: l.loan_name,
    lender: l.lender ?? '',
    loanType: l.loan_type ?? '',
    original: Number(l.original_balance),
    balance: Number(l.current_balance),
    rate: Number(l.interest_rate),
    monthly: Number(l.monthly_payment),
    paymentType: l.payment_type ?? '',
    nextPayment: l.next_payment_date ?? '',
    status: l.status ?? 'Active',
    notes: l.notes ?? '',
  }))
}

export async function getBankAccounts() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('bank_accounts')
    .select('*')
    .order('current_balance', { ascending: false })
  return (data ?? []).map((a) => ({
    id: a.id,
    accountName: a.account_name,
    accountNickname: a.account_nickname ?? '',
    institution: a.institution ?? '',
    accountType: a.account_type ?? '',
    currentBalance: Number(a.current_balance),
    availableCredit: Number(a.available_credit),
    creditLimit: Number(a.credit_limit),
    // Null is preserved as null, NOT coerced to 0. An untracked statement must stay
    // distinguishable from a card genuinely paid down to zero, otherwise a card
    // nobody has entered yet looks settled and the planner silently trusts it.
    statementBalance:
      a.statement_balance === null || a.statement_balance === undefined
        ? null
        : Number(a.statement_balance),
    statementDueDate: a.statement_due_date ?? null,
    // Which billing cycle `statementBalance` covers. Null means not recorded, which is
    // deliberately distinct from a cycle that IS recorded but has since closed: the
    // first needs the owner to enter the dates, the second needs a newer statement.
    // Without these, `lastUpdated` alone cannot tell a current statement from one left
    // over from a cycle months gone -- it only says when a number was typed.
    statementPeriodStart: a.statement_period_start ?? null,
    statementPeriodEnd: a.statement_period_end ?? null,
    // Empty string means never recorded. Staleness is judged from this, so it is
    // left falsy rather than defaulted to today — defaulting would make an
    // unmaintained figure look freshly confirmed.
    lastUpdated: a.last_updated ?? '',
    // Null means the account is OPEN. A closed account keeps its balance and history
    // and still counts toward money owed, but must be excluded from data-freshness
    // alerts, because no further statements will ever arrive for it.
    closedAt: a.closed_at ?? null,
    notes: a.notes ?? '',
  }))
}

export async function getReceivables() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('receivables')
    .select('*')
    .order('due_date', { ascending: true })
  return (data ?? []).map((r) => ({
    id: r.id,
    customerName: r.customer_name,
    invoiceNumber: r.invoice_number ?? '',
    invoiceDate: r.invoice_date ?? '',
    dueDate: r.due_date ?? '',
    amount: Number(r.amount),
    amountPaid: Number(r.amount_paid),
    expectedPaymentDate: r.expected_payment_date ?? '',
    status: r.status ?? 'Open',
    notes: r.notes ?? '',
  }))
}

export async function getCashObligations() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('cash_obligations')
    .select('*')
    .order('due_date', { ascending: true })
  return (data ?? []).map((o) => ({
    id: o.id,
    obligationName: o.obligation_name,
    category: o.category ?? '',
    vendorName: o.vendor_name ?? '',
    amount: Number(o.amount),
    dueDate: o.due_date ?? '',
    nextDueDate: o.next_due_date ?? '',
    recurring: Boolean(o.recurring),
    frequency: o.frequency ?? '',
    // True when the invoice carries no due date, so the date is the owner's own payment
    // plan. Such a bill must never be reported as overdue — there is no deadline to miss.
    selfScheduled: Boolean(o.self_scheduled),
    // Invoice date + net terms, when both are known, DERIVE the due date (see
    // resolveNextDueDate). Kept as null rather than '' / 0 so "no terms recorded" stays
    // distinguishable from "Due on Receipt", which is a real 0-day deadline.
    invoiceDate: o.invoice_date ?? null,
    paymentTermsDays:
      o.payment_terms_days == null ? null : Number(o.payment_terms_days),
    paymentMethod: o.payment_method ?? '',
    active: o.active ?? true,
    status: o.status ?? 'Pending',
    // '' means "no invoice number recorded". The write path stores NULL rather
    // than '' for a blank, so there is no ambiguous third state to represent.
    invoiceNumber: o.invoice_number ?? '',
    notes: o.notes ?? '',
  }))
}

/**
 * Collapse bill reminders into the advisor's input shape.
 *
 * Overdue and unpaid-planned are counted SEPARATELY and never summed: one is a missed
 * vendor deadline, the other is a bill with no deadline that simply has not had a check
 * written yet. Adding them together would report bills as late that have nothing to be
 * late against — the exact error this whole feature exists to avoid.
 *
 * Thresholds come from the result itself rather than a fresh settings read, so the advice
 * can never quote a different lead time than the panel it sits beside.
 */
function billsInsightFrom(r: BillReminderResult): BillsInsightInput {
  const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0)
  // 'due-today' groups with overdue: against a real vendor deadline, today is the last
  // moment to act, so it belongs with the pressing items rather than the advisory ones.
  const overdue = r.due.filter(
    (d) => d.urgency === 'overdue' || d.urgency === 'due-today',
  )
  const planned = r.due.filter((d) => d.urgency === 'unpaid-planned')
  const soon = r.due.filter((d) => d.urgency === 'due-soon')

  return {
    overdueCount: overdue.length,
    overdueTotal: sum(overdue),
    unpaidPlannedCount: planned.length,
    unpaidPlannedTotal: sum(planned),
    dueSoonCount: soon.length,
    dueSoonTotal: sum(soon),
    leadDays: r.leadDays,
    staleCheckCount: r.staleChecks.length,
    staleCheckTotal: sum(r.staleChecks),
    staleAfterDays: r.staleCheckAfterDays,
  }
}

// Raw rows (snake_case columns) for the management tables + edit forms.
export async function getRawTable(
  table: string,
  orderBy: { column: string; ascending?: boolean },
) {
  const supabase = await createClient()
  const { data } = await supabase
    .from(table)
    .select('*')
    .order(orderBy.column, { ascending: orderBy.ascending ?? true })
  return (data ?? []) as Record<string, unknown>[]
}

export type CashDebtSummary = Awaited<ReturnType<typeof getCashDebtSummary>>

// Account types that count as immediately spendable cash.
const CASH_ON_HAND_TYPES = ['Checking', 'Savings', 'Cash']
// Account types that carry a revolving credit line. Sourced from card-safety so
// there is one definition of "this account is borrowed money" in the codebase.
const CREDIT_LINE_TYPES: readonly string[] = CREDIT_ACCOUNT_TYPES
// The two credit facilities, kept apart where they must not be averaged together.
const LINE_OF_CREDIT_TYPE = 'Line of Credit'

// Days from today (inclusive) that a dated item falls within.
function daysUntil(dateStr: string, today: Date) {
  if (!dateStr) return Number.POSITIVE_INFINITY
  const d = new Date(dateStr + 'T00:00:00')
  return Math.floor((d.getTime() - today.getTime()) / 86_400_000)
}

// Derived cash position, debt load, receivables, and obligations metrics.
// Wrapped in React's `cache` so multiple callers in one render (the dashboard
// reads it via both the health snapshot and the cash forecast) share a single
// set of database queries.
export const getCashDebtSummary = cache(async () => {
  const [accounts, loans, receivables, obligations, settings] = await Promise.all([
    getBankAccounts(),
    getLoans(),
    getReceivables(),
    getCashObligations(),
    getBusinessSettings(),
  ])

  const minCashReserve = settings.min_cash_reserve

  // ---- Cash & credit ----
  // Cash On Hand = Checking + Savings + Cash balances only.
  const cashOnHand = accounts
    .filter((a) => CASH_ON_HAND_TYPES.includes(a.accountType))
    .reduce((s, a) => s + a.currentBalance, 0)

  // Available Credit = undrawn balance across all lines of credit / cards.
  const availableCredit = accounts
    .filter((a) => CREDIT_LINE_TYPES.includes(a.accountType))
    .reduce((s, a) => s + a.availableCredit, 0)

  // Total approved credit, and how much of it is currently drawn. This blends the
  // revolving line WITH credit cards on purpose: both are borrowing capacity, and
  // `operatingLiquidity` / the net-position math below need the combined figure.
  const creditLines = accounts.filter((a) =>
    CREDIT_LINE_TYPES.includes(a.accountType),
  )
  const creditLimitTotal = creditLines.reduce((s, a) => s + a.creditLimit, 0)
  const creditDrawn = creditLines.reduce((s, a) => s + a.currentBalance, 0)

  // ---- Line of credit vs. cards, kept separate --------------------------
  // The blended totals above are right for liquidity but WRONG as a headline
  // labelled "Line of Credit": they fold the Amex balance and its limit into a
  // figure the owner reads as the state of the revolving line, so a card run-up
  // silently moves a number about the credit line. The two facilities also have
  // different terms and consequences, so a utilization percentage across both
  // answers no real question. The Growth Planner already draws this same
  // distinction (see `locAccounts` in growth-planner-service) -- these fields let
  // the Dashboard state the line and the cards separately instead of averaging
  // them. Card exposure is reported in depth by the Credit Card Exposure panel.
  const locAccounts = accounts.filter((a) => a.accountType === LINE_OF_CREDIT_TYPE)
  const locLimitTotal = locAccounts.reduce((s, a) => s + a.creditLimit, 0)
  const locDrawn = locAccounts.reduce((s, a) => s + a.currentBalance, 0)
  const locAvailable = locAccounts.reduce((s, a) => s + a.availableCredit, 0)
  const hasLineOfCredit = locAccounts.length > 0

  const cardAccounts = accounts.filter((a) => a.accountType === CARD_ACCOUNT_TYPE)
  const cardLimitTotal = cardAccounts.reduce((s, a) => s + a.creditLimit, 0)
  const cardDrawn = cardAccounts.reduce((s, a) => s + a.currentBalance, 0)
  const hasCards = cardAccounts.length > 0

  // Outstanding checks: money already promised (a check is written) but not yet
  // gone from the bank, so cashOnHand still includes it. `cashAvailable` is the
  // spendable figure after subtracting those. Read here — via the bill-pay
  // service which degrades to zero on failure — so every surface that reads this
  // summary (Dashboard, Cash Flow, Marketing) shares one definition and a
  // bill-pay problem can never blank the cash dashboard.
  const { outstandingChecks, outstandingCheckCount, cashAvailable } =
    await getOutstandingCheckSummary(cashOnHand)

  // Operating Liquidity = cash on hand + available credit.
  const operatingLiquidity = cashOnHand + availableCredit

  // Legacy "cash position" label. Must count DEPOSIT balances only.
  //
  // This previously summed EVERY account, which silently counted a drawn credit
  // balance as cash: with $15,000 drawn on the line of credit, "total cash" read
  // $15,000 too high, and money owed on a credit card would have added to it as
  // well. `currentBalance` on a credit account is debt, not cash.
  //
  // Now derived from the same cash figure used everywhere else, so the two can
  // never disagree. Cash Flow already filtered credit out of its own total
  // (`app/cash-flow/page.tsx`), so this brings the summary in line with it.
  const totalCash = cashOnHand

  // Undrawn credit across borrowing accounts only. Previously unfiltered, which
  // would have swept in any stray `available_credit` sitting on a deposit row —
  // exactly how a Square Capital loan OFFER parked on the savings account could
  // have been read as spendable headroom. Same basis as `availableCredit`.
  const totalAvailableCredit = availableCredit

  // ---- Debt ----
  const totalDebt = loans.reduce((s, l) => s + l.balance, 0)
  const monthlyDebtService = loans.reduce((s, l) => s + l.monthly, 0)

  // ---- Receivables ----
  const openReceivables = receivables.filter((r) => r.status !== 'Paid')
  const totalReceivable = openReceivables.reduce(
    (s, r) => s + (r.amount - r.amountPaid),
    0,
  )

  // ---- Obligations ----
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayStr = today.toISOString().slice(0, 10)

  // Only active, unpaid obligations affect the forecast. Each one carries its
  // effective next due date (explicit override, else rolled forward by frequency).
  const pendingObligations = obligations
    .filter((o) => o.status !== 'Paid' && o.active !== false)
    .map((o) => ({ ...o, effectiveDueDate: resolveNextDueDate(o, today) }))

  const totalObligations = pendingObligations.reduce((s, o) => s + o.amount, 0)

  // Obligations with no date at all can't be projected — surface them so the
  // owner knows which records still need input.
  const obligationsMissingDueDate = pendingObligations
    .filter((o) => !o.effectiveDueDate)
    .map((o) => ({ name: o.obligationName, amount: o.amount }))

  const unscheduledObligations = obligationsMissingDueDate.reduce(
    (s, o) => s + o.amount,
    0,
  )

  // Obligations coming due within a rolling window (overdue items included).
  const obligationsWithin = (days: number) =>
    pendingObligations
      .filter((o) => daysUntil(o.effectiveDueDate, today) <= days)
      .reduce((s, o) => s + o.amount, 0)

  const obligations7 = obligationsWithin(7)
  const obligations14 = obligationsWithin(14)
  const obligations30 = obligationsWithin(30)

  // Receivables expected to collect within 14 days (by expected date, else due date).
  const expectedReceivables14 = openReceivables
    .filter((r) => {
      const ref = r.expectedPaymentDate || r.dueDate
      return daysUntil(ref, today) <= 14
    })
    .reduce((s, r) => s + (r.amount - r.amountPaid), 0)

  // Cash After 14 Days = current cash + expected receivables − known obligations.
  const cashAfter14 = cashOnHand + expectedReceivables14 - obligations14

  // Overdue = due date in the past and not yet paid.
  const overdueObligations = pendingObligations.filter(
    (o) => o.effectiveDueDate && o.effectiveDueDate < todayStr,
  )
  const overdueReceivables = openReceivables.filter(
    (r) => r.dueDate && r.dueDate < todayStr,
  )

  // Cash health uses the shared three-tier rule against the owner's reserve.
  // Treated as unknown until at least one account balance has been entered.
  const hasBalances = accounts.some((a) => a.currentBalance !== 0)
  const cashHealth = cashReserveHealth(cashAfter14, settings, hasBalances)
  const businessHealth = cashHealth.status

  // How far the 14-day projection sits above/below the reserve target.
  const reserveGap = cashAfter14 - minCashReserve

  // Projected position = cash + incoming receivables − obligations.
  const projectedPosition = totalCash + totalReceivable - totalObligations

  return {
    accounts,
    loans,
    receivables,
    obligations,
    // Core balances
    cashOnHand,
    // Spendable cash after subtracting written-but-uncleared checks. Kept
    // ALONGSIDE cashOnHand, never replacing it, so existing callers are unchanged.
    cashAvailable,
    outstandingChecks,
    outstandingCheckCount,
    availableCredit,
    creditLimitTotal,
    creditDrawn,
    // Revolving line only — what the Dashboard's line-of-credit tiles report.
    locLimitTotal,
    locDrawn,
    locAvailable,
    hasLineOfCredit,
    // Cards only, so card debt is never folded into a line-of-credit figure.
    cardLimitTotal,
    cardDrawn,
    hasCards,
    operatingLiquidity,
    totalCash,
    totalAvailableCredit,
    totalDebt,
    monthlyDebtService,
    // Receivables & obligations
    // Unpaid, active obligations each carrying their resolved next due date.
    scheduledObligations: pendingObligations,
    totalReceivable,
    totalObligations,
    obligations7,
    obligations14,
    obligations30,
    expectedReceivables14,
    cashAfter14,
    // Projections & health
    projectedPosition,
    businessHealth,
    cashHealth,
    minCashReserve,
    reserveGap,
    settings,
    obligationsMissingDueDate,
    unscheduledObligations,
    overdueObligationsCount: overdueObligations.length,
    overdueReceivablesCount: overdueReceivables.length,
    // Cash + money owed to us − everything we owe. `creditDrawn` is included
    // because a drawn line of credit and a carried card balance are real debts that
    // `totalDebt` (term loans only) does not cover. Before this, drawn credit was
    // ADDED here as cash; leaving it merely absent would still overstate net worth.
    netWorth:
      totalCash + totalReceivable - totalDebt - creditDrawn - totalObligations,
  }
})

/**
 * Marketing affordability, built on the shared cash summary.
 *
 * The cash facts are passed down rather than re-derived inside the marketing
 * service so the two can never disagree about what the business can afford.
 * Wrapped in `cache` because the dashboard, the advisor and the marketing page
 * all ask for it during a single render.
 */
export const getMarketingAffordabilitySnapshot = cache(async () => {
  const summary = await getCashDebtSummary()
  const cashAccounts = summary.accounts.filter((a) =>
    CASH_ON_HAND_TYPES.includes(a.accountType),
  )
  // Freshest balance date across the spendable accounts; a stale balance makes
  // every downstream number less trustworthy, which the engine reports.
  const balancesUpdatedAt =
    cashAccounts
      .map((a) => String(a.lastUpdated ?? ''))
      .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
      .sort()
      .pop() ?? null

  return getMarketingAffordability({
    cashOnHand: summary.cashOnHand,
    minCashReserve: summary.minCashReserve,
    obligations30: summary.obligations30,
    // Recurring bills with no due date on file. `getCashDebtSummary` keeps these
    // out of obligations30 on purpose (it cannot know WHEN they land), but for
    // affordability they must still be subtracted — a monthly Rent or Electric
    // bill is going to be paid whether or not somebody typed a date. Dropping
    // them overstated spendable cash by their full value.
    unscheduledObligations: summary.unscheduledObligations,
    unscheduledObligationNames: summary.obligationsMissingDueDate.map((o) => o.name),
    monthlyDebtService: summary.monthlyDebtService,
    creditDrawn: summary.creditDrawn,
    creditLimitTotal: summary.creditLimitTotal,
    receivables: summary.receivables.map((r) => ({
      customerName: r.customerName,
      invoiceNumber: r.invoiceNumber,
      amount: r.amount,
      amountPaid: r.amountPaid,
      status: r.status,
      notes: r.notes,
    })),
    balancesUpdatedAt,
    targetPayrollPct: summary.settings.target_payroll_pct,
    baselinePct: summary.settings.marketing_baseline_pct,
    ceilingPct: summary.settings.marketing_ceiling_pct,
    daysCashTarget: summary.settings.days_cash_target,
  })
})

/**
 * One shared evaluation of the three health pillars plus the composite score
 * and generated advisor insights. Used by the dashboard and the AI Advisor so
 * both always agree, and every threshold comes from business_settings.
 */
export async function getHealthSnapshot() {
  const [
    rawKpis,
    summary,
    squareDaily,
    cashFlowInsight,
    labor,
    checks,
  marketing,
  billPay,
  spendingCapacity,
  growthPlanner,
  proposalReviews,
  cardExposure,
  billReminders,
  ] = await Promise.all([
  getKpis(),
  getCashDebtSummary(),
  getSquareDailySales(),
  getCashFlowInsight(),
  getLaborHealthSnapshot(),
  getCheckResolutionSnapshot(),
  getMarketingAffordabilitySnapshot(),
  getBillPaySnapshot(),
  getSpendingCapacity(),
  // Both are `cache`-wrapped and share the same underlying projection, so the
  // dashboard, the advisor and the Growth Planner page all see identical figures.
  getGrowthPlannerSnapshot(),
  getSavedProposalReviews(),
  // Also `cache`-wrapped, and the same loader the dashboard, Cash & Debt and the
  // report call, so a card figure in an advisor warning always matches the panel.
  getCardExposure(),
  // `cache`-wrapped and the same loader the dashboard card calls, so the advisor
  // cannot name a bill or amount the panel disagrees with.
  getBillReminders(),
  ])
  const settings = summary.settings

  // Square is the only source that actually measures weekly sales. The stored
  // `weeklySales` KPI was never populated, so without this the sales pillar sat
  // permanently at "unknown".
  // Trailing 7 days. This remains the basis for the SALES HEALTH PILLAR, because
  // the goal ($18,000) and floor ($17,000) are whole-week targets: judging a
  // part-finished week against them would report a Monday-only $2,572 as
  // catastrophically below a $17,000 floor. A full window is the only
  // apples-to-apples comparison available.
  const squareWeekly = computeWeeklySales(squareDaily.rows)
  // Calendar week-to-date drives the DASHBOARD CARD, which is what the owner
  // reads as "this week". Clock is read once here and passed down, keeping the
  // computation pure.
  const todayISO = new Date().toISOString().slice(0, 10)
  const squareWeekToDate = computeWeekToDateSales(squareDaily.rows, todayISO)
  // Same story for the monthly card: `monthlySales` was never populated either,
  // so the dashboard showed $0 while the Sales page showed real Square figures.
  const squareMonthly = computeMonthlySales(squareDaily.rows)
  const squareSummary = summarizeDailyRows(
    squareDaily.rows,
    squareDaily.conflictDays,
  )

  // Balance-sheet figures are always derived from the live account, receivable,
  // and obligation records rather than the stored `kpis` snapshot, so editing an
  // account balance is reflected on the dashboard immediately. Trend metadata
  // from the stored row is preserved.
  const derive = (
    key: string,
    value: number,
    meta?: Record<string, string | number>,
  ) => {
    const prev = kpi(rawKpis, key)
    return {
      ...prev,
      value,
      meta: { ...prev.meta, ...(meta ?? {}) },
    }
  }

  const kpis: Kpis = {
    ...rawKpis,
    cashOnHand: derive('cashOnHand', summary.cashOnHand),
    // Revolving line ONLY. This previously used the blended credit totals, so the
    // Amex limit and balance were reported as line-of-credit utilization: the
    // Dashboard read "42% of your line drawn" when the line itself was at 43% of a
    // $35k limit and the rest was card debt. Two facilities averaged into one
    // percentage is not a number the owner can act on.
    lineOfCredit: derive('lineOfCredit', summary.locLimitTotal, {
      used: summary.locDrawn,
      available: summary.locAvailable,
    }),
    accountsReceivable: derive('accountsReceivable', summary.totalReceivable),
    accountsPayable: derive('accountsPayable', summary.totalObligations),
  }

  // Square timecards are the only source that actually measures labor. The
  // stored `payrollPct` KPI was never populated, so without this the payroll
  // pillar sat permanently at "unknown" while the Payroll page showed a real
  // figure. Falls back to the stored KPI so a farm without Square timecards
  // keeps its existing behaviour.
  const storedPayrollPct = kpi(kpis, 'payrollPct').value
  const payrollValue =
    labor.laborPct != null && labor.laborPct > 0
      ? labor.laborPct
      : storedPayrollPct
  const storedWeeklySales = kpi(kpis, 'weeklySales').value

  // Prefer the measured Square figure; fall back to the stored KPI so a farm
  // without Square keeps its existing behaviour.
  const weeklySalesValue =
    squareWeekly.netSales != null && squareWeekly.netSales > 0
      ? squareWeekly.netSales
      : storedWeeklySales

  // Monthly sales: prefer the measured Square figure, fall back to the stored
  // KPI. Gross is used rather than net so the card matches what the Sales page
  // reports for the month and what the owner sees in Square itself.
  const storedMonthlySales = kpi(kpis, 'monthlySales').value
  const monthlySalesValue =
    squareMonthly.grossSales != null && squareMonthly.grossSales > 0
      ? squareMonthly.grossSales
      : storedMonthlySales

  // Percent change for the week-to-date card, against the SAME weekdays of the
  // prior week. computeWeekToDateSales already matches those days one-for-one, so
  // the remaining guard is that every matched day actually had data
  // (priorDaysCovered === daysCovered). Null means "not comparable", which the
  // card renders by hiding the badge and its label rather than showing 0%.
  const weekToDateChange =
    squareWeekToDate.netSales != null &&
    squareWeekToDate.netSales > 0 &&
    squareWeekToDate.priorNetSales != null &&
    squareWeekToDate.priorNetSales > 0 &&
    squareWeekToDate.daysCovered === squareWeekToDate.priorDaysCovered
      ? ((squareWeekToDate.netSales - squareWeekToDate.priorNetSales) /
          squareWeekToDate.priorNetSales) *
        100
      : null

  // Percent change against the SAME span of the prior month, so a part-finished
  // month is not reported as a collapse. Null when there is nothing to compare.
  const monthlyChange =
    squareMonthly.priorNetSales != null &&
    squareMonthly.priorNetSales > 0 &&
    squareMonthly.netSales != null
      ? ((squareMonthly.netSales - squareMonthly.priorNetSales) /
          squareMonthly.priorNetSales) *
        100
      : null

  const pillars = {
    payroll: payrollHealth(payrollValue, settings, payrollValue > 0),
    cash: summary.cashHealth,
    sales: weeklySalesHealth(weeklySalesValue, settings, weeklySalesValue > 0),
  }

  const composite = compositeHealth(pillars)

  // A card payment is only worth advising on when it is BOTH forecast and the thing that
  // takes cash under the reserve. Deriving it here (rather than in health.ts) keeps the
  // rules engine pure and free of projection-walking.
  //
  // The day is found by looking for the forecast payment inside the projection, so the
  // balance quoted in the advice is the same balance the forecast table shows on that row.
  // Recomputing it independently is how two surfaces start disagreeing.
  const cardCliff = (() => {
    if (!spendingCapacity.breachesReserve) return undefined
    const candidates = spendingCapacity.cardPayments
      .map((p) => {
        const day = spendingCapacity.days.find((d) => d.date === p.dueDate)
        if (!day || !day.breachesReserve) return null
        return {
          accountName: p.accountName,
          amount: p.amount,
          dueDate: p.dueDate,
          balanceAfter: day.cautiousBalance,
          shortfall: Math.max(0, spendingCapacity.minCashReserve - day.cautiousBalance),
        }
      })
      .filter((c): c is NonNullable<typeof c> => c !== null && c.shortfall > 0)
    // Worst first, so a single insight names the payment that hurts most rather than
    // whichever card happens to sort first.
    candidates.sort((a, b) => b.shortfall - a.shortfall)
    return candidates[0]
  })()

  // Cards carrying a balance that could not be projected. Reported so the forecast's
  // optimism is visible; a silent omission would make the low point look better than it is.
  // Only cards blocked by MISSING DATA. A card whose due date simply falls past the end of
  // the forecast window is excluded: nothing is missing for it, so advising the owner to
  // "add the statement due date in Admin" would send them to fill in a field already
  // filled. The forecast panel still lists it, labelled as known-but-further-out.
  const unforecastCards = spendingCapacity.blockedCardPayments
    .filter((p) => !p.blockedBeyondHorizon)
    .map((p) => ({
      accountName: p.accountName,
      reason: p.blockedReason ?? 'not enough information',
    }))

  const insights = generateInsights({
    settings,
    pillars,
    obligationsMissingDueDate: summary.obligationsMissingDueDate,
    overdueObligations: summary.overdueObligationsCount,
    square: {
      weeklyNetSales: squareWeekly.netSales,
      priorWeeklyNetSales: squareWeekly.priorNetSales,
      totalNetSales: squareSummary.netSales,
      totalRefunds: squareSummary.refunds,
      totalProcessingFees: squareSummary.processingFees,
      latestDate: squareWeekly.latestDate,
      conflictDayCount: squareSummary.conflictDays.length,
    },
    // Omitted entirely when the planner has no data, so an empty database cannot
    // produce commitment advice. `maxRecurring` is the STRESSED recommendation —
    // passing the unstressed edge here would let the advisor headline a number that
    // breaks on a small sales dip.
    growth: growthPlanner.hasData
      ? {
          headlineRecurring: growthPlanner.maxRecurring,
          edgeRecurring: growthPlanner.edgeRecurring,
          stressDeclinePct: growthPlanner.activeMode.headlineStressSalesDeclinePct,
          modeLabel: growthPlanner.activeMode.label,
          changedProposals: proposalReviews
            .filter((r) => r.changed)
            .map((r) => ({
              name: r.name,
              fromClassification: r.originalClassification,
              toClassification: r.live.classification,
              worsened: r.worsened,
            })),
          approvedCount: proposalReviews.filter((r) => r.approvedAt != null).length,
        }
      : undefined,
    // Card exposure, read from the SAME shared loader the dashboard, Cash & Debt and
    // the report use, so the advisor can never warn about a different number than the
    // one on screen. Omitted when no card accounts exist.
    //
    // `totalOwed` is passed through as-is, including null. Coercing it to 0 here would
    // silently convert "nobody has entered a balance" into "you owe nothing" and
    // suppress the very warning this block exists to raise.
    cards: cardExposure.hasCards
      ? {
          totalOwed: cardExposure.totalOwed,
          cardCount: cardExposure.cardCount,
          confirmedCount: cardExposure.confirmedCount,
          monthsBehind: cardExposure.monthsBehind,
          // Open-scoped, so the date quoted in the warning cannot contradict the
          // months-behind figure it appears next to.
          lastActivityDate: cardExposure.lastOpenActivityDate,
          typicalMonthlyCharges: cardExposure.typicalMonthlyCharges,
          highUtilization: cardExposure.highUtilization,
        }
      : undefined,
    // Bill reminders, read from the SAME shared loader the dashboard card uses, so the
    // advisor can never name a different bill or amount than the one on screen.
    // Omitted entirely when nothing is due and nothing is stale, so a tidy week
    // generates no advice rather than four "0 bills" items.
    bills:
      billReminders.due.length > 0 || billReminders.staleChecks.length > 0
        ? billsInsightFrom(billReminders)
        : undefined,
    // Same guard as cash flow: with no timecards there is nothing to advise on,
    // so the group is omitted rather than passed as zeros.
    labor: labor.hasData
      ? {
          laborPct: labor.laborPct,
          monthLabel: labor.monthLabel,
          estimatedGrossLabor: labor.estimatedGrossLabor,
          payableHours: labor.payableHours,
          overtimeHours: labor.overtimeHours,
          estimatedOvertimeCost: labor.estimatedOvertimeCost,
          unpricedHours: labor.unpricedHours,
          unpricedShifts: labor.unpricedShifts,
          unpricedBy: labor.unpricedBy,
          likelyMissedClockOuts: labor.likelyMissedClockOuts,
          salesPerLaborHour: labor.salesPerLaborHour,
          rolling3Pct: labor.rolling3.laborPct,
          rolling3Months: labor.rolling3.monthsCounted,
          allTimePct: labor.allTime.laborPct,
          allTimeMonths: labor.allTime.monthsCounted,
        }
      : undefined,
    // Same guard again: no CHECK lines means nothing to attribute, so the group
    // is omitted rather than passed as zeros.
    checks: checks.hasChecks
      ? {
          pendingCount: checks.progress.pendingCount,
          pendingAmount: checks.progress.pendingAmount,
          resolvedCount: checks.progress.resolvedCount,
          resolvedPctOfAmount: checks.progress.resolvedPctOfAmount,
          baseCogsAmount: checks.readiness.identifiedCogs,
          unresolvedVsCogsRatio: checks.readiness.unresolvedVsCogsRatio,
          grossProfitReady: checks.readiness.ready,
          topClusters: checks.topClusters,
          monthsMissingCogs: checks.monthsMissingCogs,
          monthsMissingBankData: checks.monthsMissingBankData,
          withCheckNumberCount: checks.unresolvedWithCheckNumber,
          attachedCount: checks.unresolvedWithScan,
        }
      : undefined,
    // Only pass the group when transactions actually exist, so a farm with no
    // imported bank data gets no cash-flow insights rather than ones built on
    // zeros.
    cashFlow:
      cashFlowInsight.transactionCount > 0
        ? {
            latestCompleteMonth: cashFlowInsight.monthly.latestCompleteMonth
              ? {
                  month: cashFlowInsight.monthly.latestCompleteMonth.month,
                  inflow: cashFlowInsight.monthly.latestCompleteMonth.inflow,
                  outflow: cashFlowInsight.monthly.latestCompleteMonth.outflow,
                  net: cashFlowInsight.monthly.latestCompleteMonth.net,
                }
              : null,
            topPayee: cashFlowInsight.outflows.payees[0]
              ? {
                  payee: cashFlowInsight.outflows.payees[0].payee,
                  amount: cashFlowInsight.outflows.payees[0].amount,
                  share: cashFlowInsight.outflows.payees[0].share,
                }
              : null,
            unidentifiedOutflow: {
              amount: cashFlowInsight.outflows.unidentified.amount,
              count: cashFlowInsight.outflows.unidentified.count,
              share: cashFlowInsight.outflows.unidentified.share,
            },
            categoryCoverage: cashFlowInsight.spendByCategory.coverage,
            incompleteMonthCount:
              cashFlowInsight.monthly.incompleteMonths.length,
            mistypedCategoryCount:
              cashFlowInsight.spendByCategory.suspectedMistyped.length,
          }
        : undefined,
    // Same guard once more: with no transactions or no revenue history there is
    // nothing to base a budget on, so the group is omitted rather than passed as
    // zeros that would read as "you can afford $0".
    marketing: marketing.hasData
      ? {
          recommended: marketing.budget.recommended,
          current: Math.max(marketing.committedMonthly, marketing.spend.avg3Month),
          categorizedMonthly: marketing.spend.avg3Month,
          additionalSafe: marketing.additionalSafe,
          band: marketing.score.band,
          action: marketing.recommendation.action,
          summary: marketing.recommendation.summary,
          blockers: marketing.recommendation.blockers,
          reserveCoverage: marketing.metrics.reserveCoverage,
          commitmentMismatch: marketing.commitmentMismatch,
          confidenceLabel: marketing.confidence.recommendation.label,
          seasonalLabel: marketing.seasonality.nextMonth?.label ?? null,
          seasonalIndex: marketing.seasonality.nextMonth?.index ?? null,
          lapsedChannels: marketing.reconciliation.lapsed.map((l) => ({
            channel: l.channel,
            lastDate: l.lastDate,
            monthsSinceLastCharge: l.monthsSinceLastCharge,
            typicalMonthly: l.typicalMonthly,
          })),
          // Null rather than zeros when the books are clean, so the advisor stays
          // silent instead of reporting "$0 uncategorized".
          uncategorized:
            marketing.uncategorizedMarketing.channels.length > 0
              ? {
                  total: marketing.uncategorizedMarketing.total,
                  impliedMonthly: marketing.uncategorizedMarketing.impliedMonthly,
                  topChannels: marketing.uncategorizedMarketing.channels
                    .slice(0, 3)
                    .map((c) => c.channel),
                }
              : null,
        }
      : undefined,
    // Omit entirely when no checks are outstanding, so a farm not using Bill Pay
    // gets no bill-pay insight rather than one built on zeros.
    billPay:
      billPay.outstandingCheckCount > 0
        ? {
            outstandingChecks: billPay.outstandingChecks,
            outstandingCheckCount: billPay.outstandingCheckCount,
            oldestOutstandingDays: billPay.oldestOutstandingDays,
            cashAvailable: summary.cashAvailable,
            minCashReserve: summary.minCashReserve,
          }
        : undefined,
    // Needs 8+ complete weeks of deposits before it will pass judgement on
    // whether the business covers its costs; below that the group is omitted so
    // a thin ledger produces no verdict rather than a wrong one.
    //
    // The group is emitted when there are 8+ weeks OR when there is a dated card fact to
    // report. The weekly-gap verdict has its own `weeksObserved >= 8` gate inside
    // generateInsights, so passing the group with a thin ledger cannot produce a solvency
    // claim — but it does let a card payment be reported, which depends on the card's own
    // balance and due date rather than on history.
    spending:
      spendingCapacity.estimate.weeksObserved >= 8 ||
      cardCliff !== undefined ||
      unforecastCards.length > 0
        ? {
            typicalWeeklyInflow: spendingCapacity.estimate.typicalInflow,
            typicalWeeklyOutflow: spendingCapacity.estimate.typicalOutflow,
            weeksObserved: spendingCapacity.estimate.weeksObserved,
            safeToSpendToday: spendingCapacity.safeToSpendToday,
            breachesReserve: spendingCapacity.breachesReserve,
            cardCliff,
            unforecastCards: unforecastCards.length > 0 ? unforecastCards : undefined,
          }
        : undefined,
  })

  // Surface the weekly figure on the KPI the dashboard already renders, so the
  // card and the health pillar can never show different numbers.
  const kpisWithSquare: Kpis = {
    ...kpis,
    payrollPct: {
      ...kpi(kpis, 'payrollPct'),
      value: payrollValue,
      meta: {
        ...kpi(kpis, 'payrollPct').meta,
        ...(labor.laborPct != null && labor.laborPct > 0
          ? {
              source: 'Square timecards',
              month: labor.monthLabel ?? '',
              // Unpriced hours mean the true ratio can only be higher. `meta`
              // holds string|number only, so pass the hours and let the UI
              // decide how to caveat it.
              unpricedHours: Math.round(labor.unpricedHours),
            }
          : {}),
      },
    },
    weeklySales: {
      ...kpi(kpis, 'weeklySales'),
      // The card now reports the CALENDAR week so far, not the trailing 7 days.
      // `hasData: 0` (no day of this week recorded yet) is surfaced rather than
      // collapsed to a 0 value, so the card can say "not recorded yet" instead of
      // printing $0 and implying a week with no sales.
      value: squareWeekToDate.netSales ?? 0,
      // Overwrite trend/change rather than inheriting them: the stored row's
      // figures describe a week this value no longer represents. The stored
      // `kpis` table is empty, so inheriting left this permanently null while the
      // card still printed "vs prior week" with no number beside it.
      change: weekToDateChange,
      trend:
        weekToDateChange == null ? null : weekToDateChange >= 0 ? 'up' : 'down',
      meta: {
        ...kpi(kpis, 'weeklySales').meta,
        source: 'Square',
        hasData: squareWeekToDate.netSales == null ? 0 : 1,
        weekStart: squareWeekToDate.weekStart,
        throughDate: squareWeekToDate.throughDate ?? '',
        daysCovered: squareWeekToDate.daysCovered,
        priorDaysCovered: squareWeekToDate.priorDaysCovered,
        priorNetSales: squareWeekToDate.priorNetSales ?? 0,
        // The trailing-7-day figure the health pillar actually judges, exposed so
        // the card can state BOTH standards. Without this the card would show
        // $2,572 beside a pillar saying "On Track" against a $17,000 floor, which
        // reads as a contradiction rather than two different windows.
        trailingSevenDay: squareWeekly.netSales ?? 0,
        trailingThroughDate: squareWeekly.latestDate ?? '',
      },
    },
    monthlySales: {
      ...kpi(kpis, 'monthlySales'),
      value: monthlySalesValue,
      // Overwrite trend/change rather than inheriting them: the stored row's
      // figures describe a month this value no longer represents.
      change: monthlyChange,
      trend: monthlyChange == null ? null : monthlyChange >= 0 ? 'up' : 'down',
      meta: {
        ...kpi(kpis, 'monthlySales').meta,
        ...(squareMonthly.grossSales != null && squareMonthly.grossSales > 0
          ? {
              source: 'Square',
              monthStart: squareMonthly.monthStart ?? '',
              throughDate: squareMonthly.latestDate ?? '',
              daysCovered: squareMonthly.daysCovered,
              monthComplete: squareMonthly.monthComplete ? 1 : 0,
              netSales: squareMonthly.netSales ?? 0,
              transactionCount: squareMonthly.transactionCount,
            }
          : {}),
      },
    },
  }

  return {
    kpis: kpisWithSquare,
    settings,
    summary,
    pillars,
    composite,
    insights,
    // `monthly` rides alongside `weekly` so the dashboard card, the advisor, and
    // reporting all quote the same month-to-date figure and the same caveat
    // about how far through the month it is.
    square: { weekly: squareWeekly, monthly: squareMonthly, summary: squareSummary },
    // Exposed so the dashboard and reporting render the same cash-flow figures
    // the advisor reasons about.
    cashFlow: cashFlowInsight,
    // Same contract for labor: one measured source behind the dashboard,
    // advisor, and reporting.
    labor,
    // Check resolution readiness. Exposed here so the dashboard's Gross Profit
    // card, the advisor, and reporting all gate on the SAME judgement about
    // whether a margin can be stated yet — they cannot drift apart.
    checks,
    // Marketing affordability. Same contract: the dashboard card, the advisor
    // insights, and reporting all read this one evaluation, so none of them can
    // quote a budget the others would call unaffordable.
    marketing,
    // Bill-pay outstanding-check position. Same contract once more: the dashboard
    // tile, the advisor, and reporting all read this one snapshot so the
    // spendable-cash figure and the outstanding-check count never drift apart.
    billPay,
    // Growth Planner position and every saved proposal re-checked live. Same
    // contract as the rest: the dashboard card, the advisor insights and the admin
    // report all read these two, so none of them can state a commitment figure the
    // Growth Planner page itself would contradict.
    growthPlanner,
    proposalReviews,
  }
}

export async function getRecommendations() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('recommendations')
    .select('*')
    .order('created_at', { ascending: true })
  return (data ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    detail: r.detail ?? '',
    impact: r.impact ?? '',
    severity: (r.severity ?? 'opportunity') as 'critical' | 'warning' | 'opportunity',
    category: r.category ?? '',
  }))
}

// Derived: inventory value grouped by category (for the pie chart).
export async function getInventoryByCategory() {
  const items = await getInventory()
  const map = new Map<string, number>()
  for (const i of items) {
    map.set(i.category, (map.get(i.category) ?? 0) + i.value)
  }
  return Array.from(map.entries()).map(([category, value]) => ({ category, value }))
}
