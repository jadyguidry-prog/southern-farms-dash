import { Wallet, ArrowDownToLine, ArrowUpFromLine, Scale } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { CashFlowChart } from '@/components/charts/cash-flow-chart'
import { CashForecastChart } from '@/components/charts/cash-forecast-chart'
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
import { getBankAccounts, getCashFlowMonthly, getCashForecast } from '@/lib/queries'

export default async function CashFlowPage() {
  const [bankAccounts, cashFlowMonthly, cashForecast] = await Promise.all([
    getBankAccounts(),
    getCashFlowMonthly(),
    getCashForecast(),
  ])

  // Credit lines are a borrowing facility, not cash on hand, so they're listed
  // separately and excluded from the cash total.
  const isCreditLine = (type: string) => /credit|loan/i.test(type)
  const depository = bankAccounts.filter((a) => !isCreditLine(a.accountType))
  const creditLines = bankAccounts.filter((a) => isCreditLine(a.accountType))

  const totalCash = depository.reduce((s, a) => s + a.currentBalance, 0)
  const ytdIn = cashFlowMonthly.reduce((s, m) => s + m.inflow, 0)
  const ytdOut = cashFlowMonthly.reduce((s, m) => s + m.outflow, 0)
  const net = ytdIn - ytdOut

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Cash Flow"
        description="Track inflows, outflows, and projected liquidity across all operating accounts."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Cash Across Accounts" value={formatCurrency(totalCash)} icon={Wallet} />
        <StatCard label="YTD Cash In" value={formatCurrency(ytdIn)} icon={ArrowDownToLine} />
        <StatCard label="YTD Cash Out" value={formatCurrency(ytdOut)} icon={ArrowUpFromLine} />
        <StatCard label="Net Operating Cash" value={formatCurrency(net)} icon={Scale} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cash In vs Cash Out</CardTitle>
            <CardDescription>Monthly, trailing 12 months</CardDescription>
          </CardHeader>
          <CardContent>
            <CashFlowChart data={cashFlowMonthly} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">30-Day Cash Forecast</CardTitle>
            <CardDescription>Projected daily position</CardDescription>
          </CardHeader>
          <CardContent>
            <CashForecastChart data={cashForecast} />
          </CardContent>
        </Card>
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
