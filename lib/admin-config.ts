export type FieldType = 'text' | 'number' | 'date' | 'select'

export type FieldDef = {
  name: string
  label: string
  type: FieldType
  required?: boolean
  options?: string[]
  placeholder?: string
  /**
   * Write NULL, not 0, when a numeric field is left blank.
   *
   * Only valid on columns that are actually nullable. Set it wherever the read path
   * distinguishes "not recorded" from a real zero — a blank statement balance saved as
   * `0` claims the card is paid off, which is a specific and expensive lie on an
   * account that runs five figures a month.
   *
   * Deliberately opt-in per field: `credit_limit` and `available_credit` are
   * `NOT NULL DEFAULT 0` in the database, so forcing NULL there would fail the write
   * instead of recording the blank.
   */
  blankIsNull?: boolean
}

/**
 * Coerce a raw form/CSV string to the correct JS type for its column.
 *
 * Lives here rather than in the server action so it can be tested directly. The rule it
 * encodes is easy to regress and expensive when it does: a blank numeric field must not
 * become 0 where the read path treats NULL as "not recorded". Saving a blank statement
 * balance as 0 asserts the card is paid off.
 */
export function coerceFieldValue(
  value: string | null,
  type: FieldType | string,
  blankIsNull = false,
): unknown {
  if (value == null || value === '') {
    if (type !== 'number') return null
    return blankIsNull ? null : 0
  }
  if (type === 'number') {
    const n = Number(String(value).replace(/[$,%\s]/g, ''))
    return Number.isFinite(n) ? n : 0
  }
  // Normalize boolean-like values (used by the "recurring" obligation flag).
  if (value === 'true') return true
  if (value === 'false') return false
  return value
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
  /**
   * Set when the table is derived from other data and must not be hand-edited
   * here. Typing directly into a calculated table looks like it works, then the
   * next recalculation silently discards it. The Admin panel shows a pointer to
   * the real controls instead of an entry form.
   */
  managedElsewhere?: { href: string; linkLabel: string; reason: string }
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
    description: 'Wholesale and retail sales by month, calculated from bank deposits.',
    managedElsewhere: {
      href: '/sales',
      linkLabel: 'Go to Sales',
      reason:
        'Monthly sales are calculated from your imported bank records. Editing them here would be erased the next time sales are recalculated, so overrides and locks live on the Sales page.',
    },
    fields: [
      { name: 'month', label: 'Month (e.g. Jan)', type: 'text', required: true },
      { name: 'month_order', label: 'Month Order (1-12)', type: 'number', required: true },
      { name: 'wholesale', label: 'Wholesale', type: 'number', required: true },
      { name: 'retail', label: 'Retail', type: 'number', required: true },
    ],
    displayColumns: [
      { name: 'year', label: 'Year' },
      { name: 'month', label: 'Month' },
      { name: 'wholesale', label: 'Wholesale', format: 'currency' },
      { name: 'retail', label: 'Retail', format: 'currency' },
      { name: 'source', label: 'Source' },
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
    key: 'bank_accounts',
    table: 'bank_accounts',
    label: 'Bank Accounts',
    description:
      'Operating, savings, credit line, and credit card balances. For a credit card, ' +
      'Current Balance is what you OWE. Keep Last Updated current — the Growth ' +
      'Planner lowers its confidence when a figure has gone stale.',
    fields: [
      { name: 'account_name', label: 'Account Name', type: 'text', required: true },
      { name: 'account_nickname', label: 'Account Nickname', type: 'text' },
      { name: 'institution', label: 'Institution', type: 'text' },
      {
        name: 'account_type',
        label: 'Account Type',
        type: 'select',
        required: true,
        options: ['Checking', 'Savings', 'Line of Credit', 'Cash', 'Credit Card'],
      },
      { name: 'current_balance', label: 'Current Balance', type: 'number', required: true },
      { name: 'available_credit', label: 'Available Credit', type: 'number' },
      { name: 'credit_limit', label: 'Credit Limit', type: 'number' },
      // Card-only, and intentionally optional: left blank they stay NULL, which the
      // planner reports as "not tracked" rather than treating as a paid-off card.
      {
        name: 'statement_balance',
        label: 'Statement Balance (cards)',
        type: 'number',
        // Load-bearing. Without this a blank saves as 0, and the whole read path
        // (queries.ts, card-safety.ts) treats 0 as a confirmed "nothing due".
        blankIsNull: true,
      },
      {
        name: 'statement_due_date',
        label: 'Statement Due Date (cards)',
        type: 'date',
      },
      { name: 'last_updated', label: 'Last Updated', type: 'date' },
      { name: 'notes', label: 'Notes', type: 'text' },
    ],
    displayColumns: [
      { name: 'account_name', label: 'Account' },
      { name: 'account_type', label: 'Type' },
      { name: 'current_balance', label: 'Balance', format: 'currency' },
      // Surfaced in the list so a stale row is visible without opening it.
      { name: 'last_updated', label: 'Updated' },
    ],
    orderBy: { column: 'current_balance', ascending: false },
  },
  {
    key: 'loans',
    table: 'loans',
    label: 'Loans & Credit',
    description: 'Debt obligations and payment schedule.',
    fields: [
      { name: 'loan_name', label: 'Loan Name', type: 'text', required: true },
      { name: 'lender', label: 'Lender', type: 'text' },
      {
        name: 'loan_type',
        label: 'Loan Type',
        type: 'select',
        options: [
          'Term Loan',
          'Line of Credit',
          'Equipment',
          'Real Estate / Mortgage',
          'SBA',
          'Vehicle',
          'Other',
        ],
      },
      { name: 'original_balance', label: 'Original Amount', type: 'number', required: true },
      { name: 'current_balance', label: 'Current Balance', type: 'number', required: true },
      { name: 'interest_rate', label: 'Interest Rate (%)', type: 'number', required: true },
      { name: 'monthly_payment', label: 'Monthly Payment', type: 'number' },
      {
        name: 'payment_type',
        label: 'Payment Type',
        type: 'select',
        options: ['Principal + Interest', 'Interest Only', 'Revolving'],
      },
      { name: 'next_payment_date', label: 'Next Payment', type: 'date' },
      { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Paid Off', 'Delinquent'] },
      { name: 'notes', label: 'Notes', type: 'text' },
    ],
    displayColumns: [
      { name: 'loan_name', label: 'Loan' },
      { name: 'current_balance', label: 'Balance', format: 'currency' },
      { name: 'interest_rate', label: 'Rate', format: 'percent' },
    ],
    orderBy: { column: 'current_balance', ascending: false },
  },
  {
    key: 'receivables',
    table: 'receivables',
    label: 'Receivables',
    description: 'Customer invoices and expected incoming payments.',
    fields: [
      { name: 'customer_name', label: 'Customer', type: 'text', required: true },
      { name: 'invoice_number', label: 'Invoice #', type: 'text' },
      { name: 'invoice_date', label: 'Invoice Date', type: 'date' },
      { name: 'due_date', label: 'Due Date', type: 'date' },
      { name: 'amount', label: 'Amount', type: 'number', required: true },
      { name: 'amount_paid', label: 'Amount Paid', type: 'number' },
      { name: 'expected_payment_date', label: 'Expected Payment', type: 'date' },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: ['Open', 'Partial', 'Paid', 'Overdue'],
      },
      { name: 'notes', label: 'Notes', type: 'text' },
    ],
    displayColumns: [
      { name: 'customer_name', label: 'Customer' },
      { name: 'amount', label: 'Amount', format: 'currency' },
      { name: 'status', label: 'Status' },
    ],
    orderBy: { column: 'due_date', ascending: true },
  },
  {
    key: 'cash_obligations',
    table: 'cash_obligations',
    label: 'Cash Obligations',
    description: 'Upcoming bills, payments, and recurring expenses.',
    fields: [
      { name: 'obligation_name', label: 'Obligation', type: 'text', required: true },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        options: ['Payroll', 'Vendor', 'Loan Payment', 'Tax', 'Utility', 'Rent/Lease', 'Insurance', 'Other'],
      },
      { name: 'vendor_name', label: 'Payee / Vendor', type: 'text' },
      { name: 'amount', label: 'Amount', type: 'number', required: true },
      { name: 'due_date', label: 'Due Date', type: 'date', required: true },
      {
        name: 'frequency',
        label: 'Recurring Frequency',
        type: 'select',
        required: true,
        options: ['One-time', 'Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Annually'],
      },
      { name: 'next_due_date', label: 'Next Due Date', type: 'date' },
      {
        name: 'active',
        label: 'Active Status',
        type: 'select',
        required: true,
        options: ['true', 'false'],
      },
      { name: 'recurring', label: 'Recurring?', type: 'select', options: ['false', 'true'] },
      {
        name: 'payment_method',
        label: 'Payment Method',
        type: 'select',
        options: ['ACH', 'Check', 'Wire', 'Credit Card', 'Auto-Draft', 'Cash'],
      },
      { name: 'status', label: 'Status', type: 'select', options: ['Pending', 'Scheduled', 'Paid'] },
      { name: 'notes', label: 'Notes', type: 'text' },
    ],
    displayColumns: [
      { name: 'obligation_name', label: 'Obligation' },
      { name: 'amount', label: 'Amount', format: 'currency' },
      { name: 'due_date', label: 'Due' },
      { name: 'frequency', label: 'Frequency' },
    ],
    orderBy: { column: 'due_date', ascending: true },
  },
  {
    key: 'business_settings',
    table: 'business_settings',
    label: 'Business Settings',
    description: 'Operating targets and thresholds used across the dashboard.',
    fields: [
      { name: 'setting_key', label: 'Setting Key', type: 'text', required: true },
      { name: 'label', label: 'Label', type: 'text', required: true },
      { name: 'value', label: 'Value', type: 'number', required: true },
      {
        name: 'unit',
        label: 'Unit',
        type: 'select',
        options: ['currency', 'percent', 'number'],
      },
      { name: 'notes', label: 'Notes', type: 'text' },
    ],
    displayColumns: [
      { name: 'label', label: 'Setting' },
      { name: 'value', label: 'Value' },
      { name: 'unit', label: 'Unit' },
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
