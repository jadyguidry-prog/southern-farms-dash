export type FieldType = 'text' | 'number' | 'date' | 'select'

export type FieldDef = {
  name: string
  label: string
  type: FieldType
  required?: boolean
  options?: string[]
  placeholder?: string
}

export type TableDef = {
  key: string
  table: string
  label: string
  description: string
  fields: FieldDef[]
  /** columns shown in the current-records preview table */
  displayColumns: { name: string; label: string; format?: 'currency' | 'number' | 'percent' }[]
  orderBy?: { column: string; ascending?: boolean }
}

export const ADMIN_TABLES: TableDef[] = [
  {
    key: 'cash_accounts',
    table: 'cash_accounts',
    label: 'Cash Accounts',
    description: 'Bank and merchant account balances.',
    fields: [
      { name: 'name', label: 'Account Name', type: 'text', required: true },
      { name: 'bank', label: 'Bank / Institution', type: 'text' },
      { name: 'balance', label: 'Balance', type: 'number', required: true },
    ],
    displayColumns: [
      { name: 'name', label: 'Account' },
      { name: 'bank', label: 'Bank' },
      { name: 'balance', label: 'Balance', format: 'currency' },
    ],
    orderBy: { column: 'created_at', ascending: true },
  },
  {
    key: 'cash_flow_monthly',
    table: 'cash_flow_monthly',
    label: 'Monthly Cash Flow',
    description: 'Cash inflows and outflows by month.',
    fields: [
      { name: 'month', label: 'Month (e.g. Jan)', type: 'text', required: true },
      { name: 'month_order', label: 'Month Order (1-12)', type: 'number', required: true },
      { name: 'inflow', label: 'Cash In', type: 'number', required: true },
      { name: 'outflow', label: 'Cash Out', type: 'number', required: true },
    ],
    displayColumns: [
      { name: 'month', label: 'Month' },
      { name: 'inflow', label: 'Cash In', format: 'currency' },
      { name: 'outflow', label: 'Cash Out', format: 'currency' },
    ],
    orderBy: { column: 'month_order', ascending: true },
  },
  {
    key: 'sales_monthly',
    table: 'sales_monthly',
    label: 'Monthly Sales',
    description: 'Wholesale and retail sales by month.',
    fields: [
      { name: 'month', label: 'Month (e.g. Jan)', type: 'text', required: true },
      { name: 'month_order', label: 'Month Order (1-12)', type: 'number', required: true },
      { name: 'wholesale', label: 'Wholesale', type: 'number', required: true },
      { name: 'retail', label: 'Retail', type: 'number', required: true },
    ],
    displayColumns: [
      { name: 'month', label: 'Month' },
      { name: 'wholesale', label: 'Wholesale', format: 'currency' },
      { name: 'retail', label: 'Retail', format: 'currency' },
    ],
    orderBy: { column: 'month_order', ascending: true },
  },
  {
    key: 'sales_by_product',
    table: 'sales_by_product',
    label: 'Sales by Product',
    description: 'Revenue by product line.',
    fields: [
      { name: 'product', label: 'Product', type: 'text', required: true },
      { name: 'revenue', label: 'Revenue', type: 'number', required: true },
    ],
    displayColumns: [
      { name: 'product', label: 'Product' },
      { name: 'revenue', label: 'Revenue', format: 'currency' },
    ],
  },
  {
    key: 'inventory',
    table: 'inventory',
    label: 'Inventory',
    description: 'Stock items, valuation, and turnover.',
    fields: [
      { name: 'sku', label: 'SKU', type: 'text', required: true },
      { name: 'item', label: 'Item', type: 'text', required: true },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        options: ['Ready-to-Sell', 'Value-Added', 'Shelf-Stable', 'Fresh', 'Seasonal'],
      },
      { name: 'units', label: 'Units', type: 'number', required: true },
      { name: 'value', label: 'Value', type: 'number', required: true },
      { name: 'turnover', label: 'Turnover', type: 'select', options: ['Fast', 'Medium', 'Slow'] },
      { name: 'days_on_hand', label: 'Days on Hand', type: 'number' },
    ],
    displayColumns: [
      { name: 'sku', label: 'SKU' },
      { name: 'item', label: 'Item' },
      { name: 'units', label: 'Units', format: 'number' },
      { name: 'value', label: 'Value', format: 'currency' },
    ],
    orderBy: { column: 'created_at', ascending: true },
  },
  {
    key: 'payroll_trend',
    table: 'payroll_trend',
    label: 'Payroll Trend',
    description: 'Monthly payroll cost vs sales.',
    fields: [
      { name: 'month', label: 'Month (e.g. Jul)', type: 'text', required: true },
      { name: 'month_order', label: 'Month Order (1-12)', type: 'number', required: true },
      { name: 'payroll', label: 'Payroll Cost', type: 'number', required: true },
      { name: 'sales', label: 'Sales', type: 'number', required: true },
    ],
    displayColumns: [
      { name: 'month', label: 'Month' },
      { name: 'payroll', label: 'Payroll', format: 'currency' },
      { name: 'sales', label: 'Sales', format: 'currency' },
    ],
    orderBy: { column: 'month_order', ascending: true },
  },
  {
    key: 'departments',
    table: 'departments',
    label: 'Departments',
    description: 'Headcount and monthly labor cost by department.',
    fields: [
      { name: 'name', label: 'Department', type: 'text', required: true },
      { name: 'employees', label: 'Employees', type: 'number', required: true },
      { name: 'monthly_cost', label: 'Monthly Cost', type: 'number', required: true },
    ],
    displayColumns: [
      { name: 'name', label: 'Department' },
      { name: 'employees', label: 'Employees', format: 'number' },
      { name: 'monthly_cost', label: 'Monthly Cost', format: 'currency' },
    ],
  },
  {
    key: 'vendors',
    table: 'vendors',
    label: 'Vendors',
    description: 'Accounts payable and vendor terms.',
    fields: [
      { name: 'name', label: 'Vendor', type: 'text', required: true },
      { name: 'category', label: 'Category', type: 'text' },
      { name: 'balance', label: 'Balance Owed', type: 'number', required: true },
      { name: 'due_date', label: 'Due Date', type: 'date' },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: ['Upcoming', 'Due Soon', 'Overdue'],
      },
    ],
    displayColumns: [
      { name: 'name', label: 'Vendor' },
      { name: 'balance', label: 'Balance', format: 'currency' },
      { name: 'status', label: 'Status' },
    ],
    orderBy: { column: 'created_at', ascending: true },
  },
  {
    key: 'wholesale_customers',
    table: 'wholesale_customers',
    label: 'Wholesale Customers',
    description: 'Wholesale accounts and receivables.',
    fields: [
      { name: 'name', label: 'Customer', type: 'text', required: true },
      { name: 'region', label: 'Region', type: 'text' },
      { name: 'ytd', label: 'YTD Revenue', type: 'number', required: true },
      { name: 'outstanding', label: 'Outstanding AR', type: 'number', required: true },
      { name: 'terms', label: 'Terms', type: 'select', options: ['Net 15', 'Net 30', 'Net 45'] },
      { name: 'status', label: 'Status', type: 'select', options: ['Current', 'Watch'] },
    ],
    displayColumns: [
      { name: 'name', label: 'Customer' },
      { name: 'ytd', label: 'YTD', format: 'currency' },
      { name: 'outstanding', label: 'Outstanding', format: 'currency' },
    ],
    orderBy: { column: 'created_at', ascending: true },
  },
  {
    key: 'loans',
    table: 'loans',
    label: 'Loans & Credit',
    description: 'Debt obligations and payment schedule.',
    fields: [
      { name: 'name', label: 'Loan Name', type: 'text', required: true },
      { name: 'lender', label: 'Lender', type: 'text' },
      { name: 'original', label: 'Original Amount', type: 'number', required: true },
      { name: 'balance', label: 'Current Balance', type: 'number', required: true },
      { name: 'rate', label: 'Interest Rate (%)', type: 'number', required: true },
      { name: 'monthly', label: 'Monthly Payment', type: 'number' },
      { name: 'next_payment', label: 'Next Payment', type: 'date' },
    ],
    displayColumns: [
      { name: 'name', label: 'Loan' },
      { name: 'balance', label: 'Balance', format: 'currency' },
      { name: 'rate', label: 'Rate', format: 'percent' },
    ],
    orderBy: { column: 'created_at', ascending: true },
  },
  {
    key: 'recommendations',
    table: 'recommendations',
    label: 'AI Recommendations',
    description: 'Advisor insights shown on the AI Advisor page.',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'detail', label: 'Detail', type: 'text', required: true },
      { name: 'impact', label: 'Estimated Impact', type: 'text' },
      {
        name: 'severity',
        label: 'Severity',
        type: 'select',
        required: true,
        options: ['critical', 'warning', 'opportunity'],
      },
      { name: 'category', label: 'Category', type: 'text' },
    ],
    displayColumns: [
      { name: 'title', label: 'Title' },
      { name: 'severity', label: 'Severity' },
      { name: 'category', label: 'Category' },
    ],
    orderBy: { column: 'created_at', ascending: true },
  },
]

export const NUMERIC_FIELDS = new Set(['number'])

export function getTableDef(key: string) {
  return ADMIN_TABLES.find((t) => t.key === key)
}
