import { createClient } from '@/lib/supabase/server'
import {
  cashReserveHealth,
  payrollHealth,
  weeklySalesHealth,
  compositeHealth,
  generateInsights,
  resolveNextDueDate,
} from '@/lib/health'

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
  min_cash_reserve: 15000,
  preferred_weekly_sales: 18000,
  minimum_weekly_sales: 17000,
  avg_monthly_wholesale: 6000,
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

export async function getCashForecast() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('cash_forecast')
    .select('*')
    .order('day_order', { ascending: true })
  return (data ?? []).map((d) => ({ day: d.day_label, balance: Number(d.balance) }))
}

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
  const { data } = await supabase
    .from('sales_monthly')
    .select('*')
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

export async function getVendors() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('vendors')
    .select('*')
    .order('due_date', { ascending: true })
  return (data ?? []).map((v) => ({
    id: v.id,
    name: v.name,
    category: v.category ?? '',
    balance: Number(v.balance),
    due: v.due_date ?? '',
    status: v.status ?? 'Upcoming',
  }))
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
    lastUpdated: a.last_updated ?? '',
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
    paymentMethod: o.payment_method ?? '',
    active: o.active ?? true,
    status: o.status ?? 'Pending',
    notes: o.notes ?? '',
  }))
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
// Account types that carry a revolving credit line.
const CREDIT_LINE_TYPES = ['Line of Credit', 'Credit Card']

// Days from today (inclusive) that a dated item falls within.
function daysUntil(dateStr: string, today: Date) {
  if (!dateStr) return Number.POSITIVE_INFINITY
  const d = new Date(dateStr + 'T00:00:00')
  return Math.floor((d.getTime() - today.getTime()) / 86_400_000)
}

// Derived cash position, debt load, receivables, and obligations metrics.
export async function getCashDebtSummary() {
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

  // Operating Liquidity = cash on hand + available credit.
  const operatingLiquidity = cashOnHand + availableCredit

  // Sum of every account balance (kept for the legacy "cash position" label).
  const totalCash = accounts.reduce((s, a) => s + a.currentBalance, 0)
  const totalAvailableCredit = accounts.reduce((s, a) => s + a.availableCredit, 0)

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
    availableCredit,
    operatingLiquidity,
    totalCash,
    totalAvailableCredit,
    totalDebt,
    monthlyDebtService,
    // Receivables & obligations
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
    netWorth: totalCash + totalReceivable - totalDebt - totalObligations,
  }
}

/**
 * One shared evaluation of the three health pillars plus the composite score
 * and generated advisor insights. Used by the dashboard and the AI Advisor so
 * both always agree, and every threshold comes from business_settings.
 */
export async function getHealthSnapshot() {
  const [kpis, summary] = await Promise.all([getKpis(), getCashDebtSummary()])
  const settings = summary.settings

  const payrollValue = kpi(kpis, 'payrollPct').value
  const weeklySalesValue = kpi(kpis, 'weeklySales').value

  const pillars = {
    payroll: payrollHealth(payrollValue, settings, payrollValue > 0),
    cash: summary.cashHealth,
    sales: weeklySalesHealth(weeklySalesValue, settings, weeklySalesValue > 0),
  }

  const composite = compositeHealth(pillars)

  const insights = generateInsights({
    settings,
    pillars,
    obligationsMissingDueDate: summary.obligationsMissingDueDate,
    overdueObligations: summary.overdueObligationsCount,
  })

  return { kpis, settings, summary, pillars, composite, insights }
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
