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
import { cashAccounts, cashFlowMonthly, formatCurrency } from '@/lib/data'

export default function CashFlowPage() {
  const totalCash = cashAccounts.reduce((s, a) => s + a.balance, 0)
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
            <CashFlowChart />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">30-Day Cash Forecast</CardTitle>
            <CardDescription>Projected daily position</CardDescription>
          </CardHeader>
          <CardContent>
            <CashForecastChart />
          </CardContent>
        </Card>
      </div>

      <div className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Account Balances</CardTitle>
            <CardDescription>Current balance by bank account</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Institution</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cashAccounts.map((a) => (
                  <TableRow key={a.name}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell className="text-muted-foreground">{a.bank}</TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCurrency(a.balance)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2">
                  <TableCell className="font-semibold">Total</TableCell>
                  <TableCell />
                  <TableCell className="text-right font-mono font-semibold">
                    {formatCurrency(totalCash)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
