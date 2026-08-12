// Mock financial data for Southern Farms Specialty Meats
// Operations Center — Version 1

export const company = {
  name: 'Southern Farms',
  division: 'Specialty Meats',
  fiscalYear: 2026,
}

export function formatCurrency(value: number, opts?: { compact?: boolean }) {
  if (opts?.compact) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

export function formatPercent(value: number, digits = 1) {
  return `${value.toFixed(digits)}%`
}

/**
 * "2026-08-03" -> "Mon 3 Aug".
 *
 * Parsed from the date PARTS rather than `new Date(iso)`, which would read the string
 * as UTC midnight and render the previous day in any negative-offset timezone.
 * Shared so the daily table and its expanded breakdown can never disagree about which
 * day an item belongs to.
 */
export function formatDayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

// ---------- Dashboard KPIs ----------
export const kpis = {
  cashOnHand: { value: 428500, change: 6.2, trend: 'up' as const },
  lineOfCredit: { value: 750000, available: 512000, used: 238000 },
  accountsReceivable: { value: 186400, change: -3.1, trend: 'down' as const },
  accountsPayable: { value: 142900, change: 4.8, trend: 'up' as const },
  inventoryValue: { value: 312750, change: 2.4, trend: 'up' as const },
  healthScore: { value: 82, label: 'Strong', change: 3 },
  weeklySales: { value: 96200, change: 8.4, trend: 'up' as const },
  monthlySales: { value: 402800, change: 5.1, trend: 'up' as const },
  payrollPct: { value: 27.4, target: 30, trend: 'down' as const },
  grossProfitPct: { value: 41.6, target: 38, trend: 'up' as const },
}

// 30-Day cash forecast — projected daily net cash position
export const cashForecast = [
  { day: 'Day 1', balance: 428500 },
  { day: 'Day 3', balance: 441200 },
  { day: 'Day 6', balance: 419800 },
  { day: 'Day 9', balance: 452300 },
  { day: 'Day 12', balance: 468900 },
  { day: 'Day 15', balance: 402100 },
  { day: 'Day 18', balance: 388400 },
  { day: 'Day 21', balance: 371200 },
  { day: 'Day 24', balance: 358900 },
  { day: 'Day 27', balance: 396500 },
  { day: 'Day 30', balance: 431800 },
]

// ---------- Cash Flow ----------
export const cashFlowMonthly = [
  { month: 'Jan', inflow: 372000, outflow: 318000 },
  { month: 'Feb', inflow: 358000, outflow: 331000 },
  { month: 'Mar', inflow: 401000, outflow: 342000 },
  { month: 'Apr', inflow: 389000, outflow: 356000 },
  { month: 'May', inflow: 424000, outflow: 361000 },
  { month: 'Jun', inflow: 448000, outflow: 372000 },
  { month: 'Jul', inflow: 462000, outflow: 388000 },
  { month: 'Aug', inflow: 439000, outflow: 401000 },
  { month: 'Sep', inflow: 456000, outflow: 379000 },
  { month: 'Oct', inflow: 478000, outflow: 392000 },
  { month: 'Nov', inflow: 502000, outflow: 418000 },
  { month: 'Dec', inflow: 531000, outflow: 436000 },
]

export const cashAccounts = [
  { name: 'Operating Account', bank: 'First National Bank', balance: 284300 },
  { name: 'Payroll Account', bank: 'First National Bank', balance: 96200 },
  { name: 'Reserve / Savings', bank: 'Regions Bank', balance: 48000 },
  { name: 'Merchant Deposits (pending)', bank: 'Square', balance: 12400 },
]

// ---------- Sales ----------
export const salesTrend = [
  { month: 'Jan', wholesale: 214000, retail: 158000 },
  { month: 'Feb', wholesale: 205000, retail: 153000 },
  { month: 'Mar', wholesale: 231000, retail: 170000 },
  { month: 'Apr', wholesale: 224000, retail: 165000 },
  { month: 'May', wholesale: 248000, retail: 176000 },
  { month: 'Jun', wholesale: 262000, retail: 186000 },
  { month: 'Jul', wholesale: 271000, retail: 191000 },
  { month: 'Aug', wholesale: 258000, retail: 181000 },
  { month: 'Sep', wholesale: 266000, retail: 190000 },
  { month: 'Oct', wholesale: 279000, retail: 199000 },
  { month: 'Nov', wholesale: 294000, retail: 208000 },
  { month: 'Dec', wholesale: 312000, retail: 219000 },
]

export const salesByProduct = [
  { product: 'Smoked Sausage', revenue: 128400 },
  { product: 'Applewood Bacon', revenue: 112900 },
  { product: 'Prepared Meals', revenue: 86300 },
  { product: 'Beef Jerky', revenue: 64100 },
  { product: 'Specialty Cuts', revenue: 58700 },
  { product: 'Seasonal / Other', revenue: 42400 },
]

// ---------- Inventory ----------
export const inventory = [
  { sku: 'SM-101', item: 'Smoked Sausage', category: 'Ready-to-Sell', units: 1840, value: 42300, turnover: 'Fast', daysOnHand: 9 },
  { sku: 'BC-204', item: 'Applewood Bacon', category: 'Ready-to-Sell', units: 1210, value: 38600, turnover: 'Fast', daysOnHand: 11 },
  { sku: 'PM-330', item: 'Prepared Meals', category: 'Value-Added', units: 640, value: 21800, turnover: 'Medium', daysOnHand: 18 },
  { sku: 'BJ-115', item: 'Beef Jerky', category: 'Shelf-Stable', units: 2050, value: 29400, turnover: 'Medium', daysOnHand: 22 },
  { sku: 'SC-410', item: 'Specialty Cuts', category: 'Fresh', units: 480, value: 31200, turnover: 'Slow', daysOnHand: 41 },
  { sku: 'RB-088', item: 'Aged Ribeye Program', category: 'Fresh', units: 320, value: 46700, turnover: 'Slow', daysOnHand: 52 },
  { sku: 'GR-071', item: 'Ground Blend', category: 'Fresh', units: 910, value: 18900, turnover: 'Fast', daysOnHand: 7 },
  { sku: 'HM-260', item: 'Holiday Ham (seasonal)', category: 'Seasonal', units: 260, value: 27400, turnover: 'Slow', daysOnHand: 63 },
]

export const inventoryByCategory = [
  { category: 'Ready-to-Sell', value: 80900 },
  { category: 'Fresh', value: 96800 },
  { category: 'Value-Added', value: 21800 },
  { category: 'Shelf-Stable', value: 29400 },
  { category: 'Seasonal', value: 27400 },
]

// ---------- Payroll ----------
export const payrollTrend = [
  { month: 'Jul', payroll: 108000, sales: 462000 },
  { month: 'Aug', payroll: 112000, sales: 439000 },
  { month: 'Sep', payroll: 106000, sales: 456000 },
  { month: 'Oct', payroll: 109000, sales: 478000 },
  { month: 'Nov', payroll: 118000, sales: 502000 },
  { month: 'Dec', payroll: 110300, sales: 402800 },
]

export const departments = [
  { name: 'Production / Butchery', employees: 18, monthlyCost: 52400 },
  { name: 'Packaging & Fulfillment', employees: 9, monthlyCost: 23800 },
  { name: 'Sales & Wholesale', employees: 6, monthlyCost: 19600 },
  { name: 'Retail Storefront', employees: 7, monthlyCost: 14900 },
  { name: 'Administration', employees: 4, monthlyCost: 17300 },
]

// ---------- Vendors ----------
export const vendors = [
  { name: 'Heartland Livestock Co.', category: 'Raw Meat Supply', balance: 58400, due: '2026-07-27', status: 'Due Soon' },
  { name: 'Oakridge Spice & Seasoning', category: 'Ingredients', balance: 12300, due: '2026-08-04', status: 'Upcoming' },
  { name: 'ClearPack Packaging', category: 'Packaging', balance: 21900, due: '2026-07-25', status: 'Due Soon' },
  { name: 'Blue Ridge Cold Storage', category: 'Logistics', balance: 15600, due: '2026-08-11', status: 'Upcoming' },
  { name: 'Southern Fuel & Freight', category: 'Distribution', balance: 9800, due: '2026-07-23', status: 'Overdue' },
  { name: 'Piedmont Equipment Lease', category: 'Equipment', balance: 24900, due: '2026-08-15', status: 'Upcoming' },
]

// ---------- Wholesale Customers ----------
export const wholesaleCustomers = [
  { name: 'Magnolia Grocers', region: 'Southeast', ytd: 284000, outstanding: 42300, terms: 'Net 30', status: 'Current' },
  { name: 'Piedmont Restaurant Group', region: 'Carolinas', ytd: 196500, outstanding: 31800, terms: 'Net 15', status: 'Current' },
  { name: 'Gulf Coast Markets', region: 'Gulf', ytd: 158200, outstanding: 58400, terms: 'Net 30', status: 'Watch' },
  { name: 'Blue Ridge Butcher Shops', region: 'Appalachia', ytd: 132700, outstanding: 18900, terms: 'Net 30', status: 'Current' },
  { name: 'Tidewater Catering Co.', region: 'Virginia', ytd: 98400, outstanding: 21000, terms: 'Net 15', status: 'Current' },
  { name: 'Delta Provisions', region: 'Mississippi', ytd: 76300, outstanding: 14000, terms: 'Net 45', status: 'Watch' },
]

// ---------- Loans ----------
export const loans = [
  {
    name: 'SBA 7(a) Expansion Loan',
    lender: 'First National Bank',
    original: 500000,
    balance: 318400,
    rate: 6.75,
    monthly: 6120,
    nextPayment: '2026-08-01',
  },
  {
    name: 'Equipment Financing',
    lender: 'Piedmont Equipment Lease',
    original: 180000,
    balance: 94200,
    rate: 5.9,
    monthly: 3480,
    nextPayment: '2026-07-28',
  },
  {
    name: 'Revolving Line of Credit',
    lender: 'First National Bank',
    original: 750000,
    balance: 238000,
    rate: 8.25,
    monthly: 0,
    nextPayment: '2026-07-31',
  },
]

// ---------- AI Advisor ----------
export type Recommendation = {
  id: string
  title: string
  detail: string
  impact: string
  severity: 'critical' | 'warning' | 'opportunity'
  category: string
}

export const recommendations: Recommendation[] = [
  {
    id: 'inv-slow',
    title: 'Convert slow-moving inventory into prepared meals',
    detail:
      'Aged Ribeye Program (52 days on hand) and Holiday Ham (63 days) are aging past target. Redirect ~$74K of slow inventory into your Prepared Meals line, which turns in 18 days and carries a higher margin.',
    impact: 'Recover ~$74K in tied-up capital · +6% blended margin',
    severity: 'opportunity',
    category: 'Inventory',
  },
  {
    id: 'vendor-due',
    title: 'Vendor payments due within 5 days',
    detail:
      'Southern Fuel & Freight is overdue ($9,800). ClearPack Packaging ($21,900) and Heartland Livestock ($58,400) are due soon. Schedule payments to protect supplier terms and avoid late fees.',
    impact: '$90,100 across 3 vendors',
    severity: 'critical',
    category: 'Vendors',
  },
  {
    id: 'cash-forecast',
    title: '30-day cash forecast dips near Day 24',
    detail:
      'Projected balance falls to ~$358K around Day 24 as payroll and vendor payments cluster. Consider drawing $50K from your available line of credit or accelerating Gulf Coast Markets receivables ($58.4K outstanding).',
    impact: 'Low point ~$358K · $512K credit available',
    severity: 'warning',
    category: 'Cash Flow',
  },
  {
    id: 'payroll-pct',
    title: 'Payroll percentage is healthy — hold the line',
    detail:
      'Payroll is 27.4% of sales, under your 30% target. December sales dipped seasonally; monitor closely so the ratio does not creep above target in the slower Q1 months ahead.',
    impact: '27.4% vs 30% target',
    severity: 'opportunity',
    category: 'Payroll',
  },
  {
    id: 'ar-aging',
    title: 'Two wholesale accounts flagged for AR watch',
    detail:
      'Gulf Coast Markets ($58.4K) and Delta Provisions ($14K) are trending slow. Consider a friendly Net-15 conversion or early-pay discount to tighten receivables.',
    impact: '$72.4K outstanding at risk',
    severity: 'warning',
    category: 'Receivables',
  },
]

export const navItems = [
  { label: 'Dashboard', href: '/' },
  { label: 'Cash Flow', href: '/cash-flow' },
  { label: 'Inventory', href: '/inventory' },
  { label: 'Payroll', href: '/payroll' },
  { label: 'Sales', href: '/sales' },
  { label: 'Vendor Management', href: '/vendors' },
  { label: 'Wholesale Customers', href: '/wholesale' },
  { label: 'Loans', href: '/loans' },
  { label: 'AI Advisor', href: '/ai-advisor' },
  { label: 'Settings', href: '/settings' },
]
