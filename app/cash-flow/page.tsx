import { Wallet, ArrowDownToLine, ArrowUpFromLine, Scale } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { CashFlowChart } from '@/components/charts/cash-flow-chart'
import { CashForecastChart } from '@/components/charts/cash-forecast-chart'
import { WhereMoneyWent } from '@/components/cash-flow/where-money-went'
import { SpendByCategory } from '@/components/cash-flow/spend-by-category'
import { ReviewNudge } from '@/components/cash-flow/review-nudge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/data'
import {
  getBankAccounts,
  getCashDebtSummary,
  getCashFlowMonthly,
} from '@/lib/queries'
import { getCashFlowInsight, monthLabel } from '@/lib/cash-flow-service'
import { getSpendingCapacity } from '@/lib/spending-capacity-data'
import { SpendingCapacityPanel } from '@/components/cash-flow/spending-capacity-panel'

export default async function CashFlowPage() {
  const [bankAccounts, summary, cashFlowMonthly, capacity, insight] =
    await Promise.all([
      getBankAccounts(),
      getCashDebtSummary(),
      getCashFlowMonthly(),
      getSpendingCapacity(),
      getCashFlowInsight(),
    ])

  // Credit lines are a borrowing facility, not cash on hand, so they're listed
  // separately and excluded from the cash total.
  const isCreditLine = (type: string) => /credit|loan/i.test(type)
  const depository = bankAccounts.filter((a) => !isCreditLine(a.accountType))
  const creditLines = bankAccounts.filter((a) => isCreditLine(a.accountType))

  const totalCash = depository.reduce((s, a) => s + a.currentBalance, 0)

  // Forward-looking movement over the next 30 days, derived from scheduled
  // obligations and expected receivable payments.
  const horizon = new Date()
  horizon.setDate(horizon.getDate() + 30)
  const horizonKey = horizon.toISOString().slice(0, 10)

  const outflows30 = summary.scheduledObligations
    .filter((o) => o.effectiveDueDate && o.effectiveDueDate <= horizonKey)
    .reduce((s, o) => s + o.amount, 0)

  const inflows30 = summary.receivables
    .filter((r) => r.status !== 'Paid')
    .filter((r) => {
      const date = r.expectedPaymentDate || r.dueDate
      return date && date <= horizonKey
    })
    .reduce((s, r) => s + Math.max(r.amount - r.amountPaid, 0), 0)

  const net30 = inflows30 - outflows30

  // Prefer the series derived from real bank transactions. The legacy
  // cash_flow_monthly table stays as a fallback but is empty in practice, and
  // it has no year column, so its rows would interleave across years.
  const derived = insight.monthly.series
  const chartData =
    derived.length > 0
      ? derived.map((m) => ({
          month: m.month,
          inflow: m.inflow,
          outflow: m.outflow,
          complete: m.complete,
        }))
      : cashFlowMonthly
  const hasHistory = chartData.length > 0
  const usingDerived = derived.length > 0

  const incompleteLabels = insight.monthly.incompleteMonths.map(monthLabel)
  const gapLabels = insight.monthly.gapMonths.map(monthLabel)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Cash Flow"
        description="Track inflows, outflows, and projected liquidity across all operating accounts."
      />

      <ReviewNudge insight={insight} className="mb-4" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total Cash Across Accounts"
          value={formatCurrency(totalCash)}
          icon={Wallet}
          hint={`${depository.length} operating ${depository.length === 1 ? 'account' : 'accounts'}`}
        />
        <StatCard
          label="Expected In (30 Days)"
          value={formatCurrency(inflows30)}
          icon={ArrowDownToLine}
          hint="Receivables due"
        />
        <StatCard
          label="Scheduled Out (30 Days)"
          value={formatCurrency(outflows30)}
          icon={ArrowUpFromLine}
          hint={
            summary.unscheduledObligations > 0
              ? `${formatCurrency(summary.unscheduledObligations)} undated`
              : 'Obligations due'
          }
        />
        <StatCard
          label="Net 30-Day Change"
          value={formatCurrency(net30)}
          icon={Scale}
          hint={net30 < 0 ? 'Cash decreasing' : 'Cash increasing'}
        />
      </div>

      <div className="mt-4">
        <SpendingCapacityPanel capacity={capacity} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cash In vs Cash Out</CardTitle>
            <CardDescription>
              {usingDerived
                ? `Monthly, from ${insight.transactionCount.toLocaleString()} imported bank transactions`
                : 'Monthly, trailing 12 months'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {hasHistory ? (
              <>
                <CashFlowChart data={chartData} />
                {usingDerived && (incompleteLabels.length > 0 || gapLabels.length > 0) && (
                  <div className="mt-3 space-y-1">
                    {incompleteLabels.length > 0 && (
                      <p className="text-xs text-muted-foreground text-pretty">
                        Faded bars ({incompleteLabels.join(', ')}) show months where
                        only a card statement was imported. They have spending but no
                        deposits, so they understate income rather than showing a real
                        loss.
                      </p>
                    )}
                    {gapLabels.length > 0 && (
                      <p className="text-xs text-muted-foreground text-pretty">
                        No transactions at all were imported for {gapLabels.join(', ')}.
                      </p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-[300px] flex-col items-center justify-center gap-2 text-center">
                <p className="text-sm font-medium text-foreground">
                  No monthly history yet
                </p>
                <p className="max-w-xs text-sm text-muted-foreground text-pretty">
                  This chart compares actual cash in and out per month. Import your
                  monthly totals from the Admin page to populate it.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">30-Day Cash Forecast</CardTitle>
            <CardDescription>
              Projected daily position from today&apos;s cash, your typical sales
              pattern, scheduled bills, and uncleared payments
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CashForecastChart
              data={capacity.thirtyDay}
              minBuffer={capacity.minCashReserve}
              showCautious
            />
            {summary.unscheduledObligations > 0 && (
              <p className="mt-2 text-xs text-muted-foreground text-pretty">
                {formatCurrency(summary.unscheduledObligations)}{' '}
                in obligations has no due date and is excluded. Add due dates on
                the Cash &amp; Debt page for a complete forecast.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <WhereMoneyWent outflows={insight.outflows} />
        <SpendByCategory data={insight.spendByCategory} />
      </div>

      <div className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Account Balances</CardTitle>
            <CardDescription>
              Live balances from your accounts. Edit them on the Cash &amp; Debt page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {bankAccounts.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No accounts yet. Add them on the Cash &amp; Debt page.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead>Institution</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {depository.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-medium">{a.accountName}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {a.institution || '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {a.accountType || '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(a.currentBalance)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="border-t-2">
                      <TableCell className="font-semibold">Total Cash</TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell className="text-right font-mono font-semibold">
                        {formatCurrency(totalCash)}
                      </TableCell>
                    </TableRow>
                    {creditLines.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-medium">{a.accountName}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {a.institution || '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {a.availableCredit > 0
                            ? `${formatCurrency(a.availableCredit)} available`
                            : a.accountType || '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(a.currentBalance)} drawn
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
