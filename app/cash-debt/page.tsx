import {
  Wallet,
  CreditCard,
  Landmark,
  CalendarClock,
  ArrowDownToLine,
  ArrowUpFromLine,
  TrendingUp,
  Scale,
  AlertTriangle,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EntityManager, type Column } from '@/components/cash-debt/entity-manager'
import { getCashDebtSummary, getRawTable } from '@/lib/queries'
import { getTableDef } from '@/lib/admin-config'
import { formatCurrency } from '@/lib/data'

const bankDef = getTableDef('bank_accounts')!
const loanDef = getTableDef('loans')!
const receivableDef = getTableDef('receivables')!
const obligationDef = getTableDef('cash_obligations')!

const bankColumns: Column[] = [
  { name: 'account_name', label: 'Account' },
  { name: 'account_type', label: 'Type' },
  { name: 'current_balance', label: 'Balance', format: 'currency' },
  { name: 'available_credit', label: 'Available Credit', format: 'currency' },
  { name: 'last_updated', label: 'Updated', format: 'date' },
]

const loanColumns: Column[] = [
  { name: 'loan_name', label: 'Loan' },
  { name: 'lender', label: 'Lender' },
  { name: 'current_balance', label: 'Balance', format: 'currency' },
  { name: 'interest_rate', label: 'Rate', format: 'percent' },
  { name: 'monthly_payment', label: 'Monthly', format: 'currency' },
  { name: 'next_payment_date', label: 'Next Payment', format: 'date' },
  { name: 'status', label: 'Status', badge: true },
]

const receivableColumns: Column[] = [
  { name: 'customer_name', label: 'Customer' },
  { name: 'invoice_number', label: 'Invoice #' },
  { name: 'amount', label: 'Amount', format: 'currency' },
  { name: 'due_date', label: 'Due', format: 'date' },
  { name: 'status', label: 'Status', badge: true },
]

const obligationColumns: Column[] = [
  { name: 'obligation_name', label: 'Obligation' },
  { name: 'category', label: 'Category' },
  { name: 'vendor_name', label: 'Payee' },
  { name: 'amount', label: 'Amount', format: 'currency' },
  { name: 'due_date', label: 'Due', format: 'date' },
  { name: 'status', label: 'Status', badge: true },
]

export default async function CashDebtPage() {
  const [summary, bankRows, loanRows, receivableRows, obligationRows] = await Promise.all([
    getCashDebtSummary(),
    getRawTable('bank_accounts', bankDef.orderBy ?? { column: 'created_at', ascending: true }),
    getRawTable('loans', loanDef.orderBy ?? { column: 'created_at', ascending: true }),
    getRawTable('receivables', receivableDef.orderBy ?? { column: 'created_at', ascending: true }),
    getRawTable('cash_obligations', obligationDef.orderBy ?? { column: 'created_at', ascending: true }),
  ])

  const hasOverdue =
    summary.overdueObligationsCount > 0 || summary.overdueReceivablesCount > 0

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Cash & Debt"
        description="Track cash on hand, credit lines, loans, incoming receivables, and upcoming obligations in one place."
      />

      {hasOverdue && (
        <Card className="mb-4 border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <AlertTriangle className="size-5" aria-hidden="true" />
            </div>
            <p className="text-sm text-foreground">
              <span className="font-semibold">Attention needed:</span>{' '}
              {summary.overdueObligationsCount > 0 && (
                <>{summary.overdueObligationsCount} overdue obligation
                  {summary.overdueObligationsCount === 1 ? '' : 's'}</>
              )}
              {summary.overdueObligationsCount > 0 &&
                summary.overdueReceivablesCount > 0 &&
                ' and '}
              {summary.overdueReceivablesCount > 0 && (
                <>{summary.overdueReceivablesCount} past-due receivable
                  {summary.overdueReceivablesCount === 1 ? '' : 's'}</>
              )}
              . Review the tabs below.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Cash Position"
          value={formatCurrency(summary.totalCash)}
          icon={Wallet}
          hint="Across all bank accounts"
        />
        <StatCard
          label="Available Credit"
          value={formatCurrency(summary.totalAvailableCredit)}
          icon={CreditCard}
          hint="Undrawn credit lines"
        />
        <StatCard
          label="Total Debt"
          value={formatCurrency(summary.totalDebt)}
          icon={Landmark}
          hint="Outstanding loan balances"
        />
        <StatCard
          label="Monthly Debt Service"
          value={formatCurrency(summary.monthlyDebtService)}
          icon={CalendarClock}
          hint="Scheduled loan payments"
        />
        <StatCard
          label="Outstanding Receivables"
          value={formatCurrency(summary.totalReceivable)}
          icon={ArrowDownToLine}
          hint={
            summary.overdueReceivablesCount > 0
              ? `${summary.overdueReceivablesCount} past due`
              : 'Expected incoming'
          }
        />
        <StatCard
          label="Upcoming Obligations"
          value={formatCurrency(summary.totalObligations)}
          icon={ArrowUpFromLine}
          hint={
            summary.overdueObligationsCount > 0
              ? `${summary.overdueObligationsCount} overdue`
              : 'Pending payments'
          }
        />
        <StatCard
          label="Projected Cash Position"
          value={formatCurrency(summary.projectedPosition)}
          icon={TrendingUp}
          hint="Cash + receivables − obligations"
        />
        <StatCard
          label="Net Position"
          value={formatCurrency(summary.netWorth)}
          icon={Scale}
          hint="Cash + AR − debt − obligations"
        />
      </div>

      <div className="mt-6">
        <Tabs defaultValue="bank">
          <TabsList className="flex-wrap">
            <TabsTrigger value="bank">Bank Accounts</TabsTrigger>
            <TabsTrigger value="loans">Loans</TabsTrigger>
            <TabsTrigger value="receivables">Receivables</TabsTrigger>
            <TabsTrigger value="obligations">Obligations</TabsTrigger>
          </TabsList>

          <TabsContent value="bank" className="mt-4">
            <EntityManager def={bankDef} rows={bankRows} columns={bankColumns} />
          </TabsContent>
          <TabsContent value="loans" className="mt-4">
            <EntityManager def={loanDef} rows={loanRows} columns={loanColumns} />
          </TabsContent>
          <TabsContent value="receivables" className="mt-4">
            <EntityManager
              def={receivableDef}
              rows={receivableRows}
              columns={receivableColumns}
              markPaidEnabled
            />
          </TabsContent>
          <TabsContent value="obligations" className="mt-4">
            <EntityManager
              def={obligationDef}
              rows={obligationRows}
              columns={obligationColumns}
              markPaidEnabled
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
