import { Landmark, CircleDollarSign, CalendarClock, Percent } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { formatCurrency, formatPercent } from '@/lib/data'
import { getLoans } from '@/lib/queries'

function formatDate(iso: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default async function LoansPage() {
  const loans = await getLoans()
  const totalBalance = loans.reduce((s, l) => s + l.balance, 0)
  const totalMonthly = loans.reduce((s, l) => s + l.monthly, 0)
  const weightedRate = totalBalance
    ? loans.reduce((s, l) => s + l.rate * l.balance, 0) / totalBalance
    : 0

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Loans & Credit"
        description="Outstanding debt, repayment progress, interest rates, and upcoming payments."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Debt Outstanding" value={formatCurrency(totalBalance)} icon={CircleDollarSign} />
        <StatCard label="Monthly Debt Service" value={formatCurrency(totalMonthly)} icon={CalendarClock} />
        <StatCard label="Blended Interest Rate" value={formatPercent(weightedRate, 2)} icon={Percent} />
        <StatCard label="Active Facilities" value={String(loans.length)} icon={Landmark} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loans.map((l) => {
          const paidPct = Math.round(((l.original - l.balance) / l.original) * 100)
          return (
            <Card key={l.name}>
              <CardHeader>
                <CardTitle className="text-base text-balance">{l.name}</CardTitle>
                <CardDescription>{l.lender}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Balance</p>
                    <p className="font-mono text-xl font-bold text-foreground">
                      {formatCurrency(l.balance)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Rate</p>
                    <p className="font-mono text-lg font-semibold text-foreground">
                      {formatPercent(l.rate, 2)}
                    </p>
                  </div>
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{paidPct}% paid down</span>
                    <span>of {formatCurrency(l.original)}</span>
                  </div>
                  <Progress value={paidPct} />
                </div>

                <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
                  <span className="text-muted-foreground">
                    {l.monthly > 0 ? 'Monthly payment' : 'Interest only'}
                  </span>
                  <span className="font-mono font-medium text-foreground">
                    {l.monthly > 0 ? formatCurrency(l.monthly) : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Next payment</span>
                  <span className="font-medium text-foreground">{formatDate(l.nextPayment)}</span>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
