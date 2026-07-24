import { createClient } from '@/lib/supabase/server'

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
    .order('balance', { ascending: false })
  return (data ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    lender: l.lender ?? '',
    original: Number(l.original),
    balance: Number(l.balance),
    rate: Number(l.rate),
    monthly: Number(l.monthly),
    nextPayment: l.next_payment ?? '',
  }))
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
