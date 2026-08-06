import {
  Wallet,
  CreditCard,
  Droplets,
  Landmark,
  CalendarClock,
  ArrowDownToLine,
  TrendingUp,
  Activity,
  AlertTriangle,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EntityManager, type Column } from '@/components/cash-debt/entity-manager'
import { getCashDebtSummary, getRawTable } from '@/lib/queries'
import { getCardExposure } from '@/lib/card-exposure-service'
import { describeCardTotal } from '@/lib/card-activity'
import { CardExposurePanel } from '@/components/cards/card-exposure-panel'
import { getTableDef } from '@/lib/admin-config'
import { formatCurrency } from '@/lib/data'

const bankDef = getTableDef('bank_accounts')!
const loanDef = getTableDef('loans')!
const receivableDef = getTableDef('receivables')!
const obligationDef = getTableDef('cash_obligations')!

const healthLabel: Record<'green' | 'yellow' | 'red' | 'unknown', string> = {
  green: 'Healthy',
  yellow: 'Caution',
  red: 'At Risk',
  unknown: 'No Data',
}

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
  { name: 'frequency', label: 'Frequency' },
  { name: 'next_due_date', label: 'Next Due', format: 'date' },
  { name: 'status', label: 'Status', badge: true },
]

export default async function CashDebtPage() {
  const [summary, cardExposure, bankRows, loanRows, receivableRows, obligationRows] = await Promise.all([
    getCashDebtSummary(),
    getCardExposure(),
    getRawTable('bank_accounts', bankDef.orderBy ?? { column: 'created_at', ascending: true }),
    getRawTable('loans', loanDef.orderBy ?? { column: 'created_at', ascending: true }),
    getRawTable('receivables', receivableDef.orderBy ?? { column: 'created_at', ascending: true }),
    getRawTable('cash_obligations', obligationDef.orderBy ?? { column: 'created_at', ascending: true }),
  ])

  // Shared with the exposure panel below, so the tile and the panel cannot disagree
  // about what is owed or about how incomplete that figure is.
  const cardTotal = describeCardTotal(cardExposure)

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

      {summary.obligationsMissingDueDate.length > 0 && (
        <Card className="mb-4 border-chart-4/40 bg-chart-4/5">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-chart-4/15 text-chart-4">
              <CalendarClock className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">
                {summary.obligationsMissingDueDate.length}{' '}
                {summary.obligationsMissingDueDate.length === 1
                  ? 'obligation needs'
                  : 'obligations need'}{' '}
                a due date
              </p>
              <p className="mt-1 text-sm text-muted-foreground text-pretty">
                {formatCurrency(summary.unscheduledObligations)} is excluded from the
                7, 14, and 30-day projections until you set due dates. Open the
                Obligations tab and add a due date and frequency for:{' '}
                <span className="font-medium text-foreground">
                  {summary.obligationsMissingDueDate.map((o) => o.name).join(', ')}
                </span>
                .
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Cash On Hand"
          value={formatCurrency(summary.cashOnHand)}
          icon={Wallet}
          hint="Checking + Savings + Cash"
        />
        {/* Deliberately the BLENDED figure — undrawn line plus card headroom — because
            operating liquidity below is built from it. The hint names both facilities
            so this is not read as the state of the revolving line alone. */}
        <StatCard
          label="Available Credit"
          value={formatCurrency(summary.availableCredit)}
          icon={CreditCard}
          hint={`Undrawn line ${formatCurrency(summary.locAvailable, { compact: true })} + card headroom`}
        />
        <StatCard
          label="Operating Liquidity"
          value={formatCurrency(summary.operatingLiquidity)}
          icon={Droplets}
          hint="Cash + available credit"
        />
        <StatCard
          label="Total Debt"
          value={formatCurrency(summary.totalDebt)}
          icon={Landmark}
          hint="Outstanding loan balances"
        />
        {/* Card debt was missing from this page entirely: totalDebt above counts
            loans only, and card balances sat in creditDrawn, which was never
            rendered. Deliberately NOT folded into Total Debt — that figure is
            described as loan balances, and silently changing its meaning would
            break the reconciliation the owner does against lender statements.
            `money()` renders an unconfirmed balance as "Not recorded" rather than
            $0, because $0 reads as "paid off" on a card that runs thousands. */}
        <StatCard
          label="Credit Cards Owed"
          value={cardTotal.value}
          icon={CreditCard}
          hint={cardTotal.caveat}
        />
        <StatCard
          label="Upcoming Obligations"
          value={formatCurrency(summary.obligations30)}
          icon={CalendarClock}
          hint={`Next 30 days · 7d ${formatCurrency(summary.obligations7)} · 14d ${formatCurrency(summary.obligations14)}`}
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
          label="Cash After 14 Days"
          value={formatCurrency(summary.cashAfter14)}
          icon={TrendingUp}
          hint={
            summary.reserveGap >= 0
              ? `${formatCurrency(summary.reserveGap)} above your ${formatCurrency(summary.minCashReserve)} reserve`
              : `${formatCurrency(Math.abs(summary.reserveGap))} below your ${formatCurrency(summary.minCashReserve)} reserve`
          }
        />
        <StatCard
          label="Business Health"
          value={healthLabel[summary.businessHealth]}
          icon={Activity}
          hint={`vs ${formatCurrency(summary.minCashReserve)} minimum cash reserve`}
        />
      </div>

      <CardExposurePanel exposure={cardExposure} className="mt-4" />

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
