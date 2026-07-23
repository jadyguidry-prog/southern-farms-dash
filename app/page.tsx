import Link from 'next/link'
import {
  Wallet,
  CreditCard,
  ArrowDownToLine,
  ArrowUpFromLine,
  Package,
  CalendarDays,
  TrendingUp,
  Sparkles,
  ArrowRight,
  AlertTriangle,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { CashForecastChart } from '@/components/charts/cash-forecast-chart'
import { CashFlowChart } from '@/components/charts/cash-flow-chart'
import { RadialStat } from '@/components/charts/radial-stat'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { kpis, recommendations, formatCurrency, formatPercent } from '@/lib/data'

const severityStyles: Record<string, string> = {
  critical: 'bg-destructive/10 text-destructive',
  warning: 'bg-chart-4/15 text-chart-4',
  opportunity: 'bg-primary/10 text-primary',
}

export default function DashboardPage() {
  const creditUsedPct = Math.round((kpis.lineOfCredit.used / kpis.lineOfCredit.value) * 100)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Good morning — here's your business at a glance"
        description="Southern Farms Specialty Meats · Fiscal Year 2026. A real-time view of cash, credit, receivables, and operating performance."
      />

      {/* Primary KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Cash on Hand"
          value={formatCurrency(kpis.cashOnHand.value)}
          icon={Wallet}
          change={kpis.cashOnHand.change}
          trend={kpis.cashOnHand.trend}
          changeLabel="vs last month"
        />
        <StatCard
          label="Available Line of Credit"
          value={formatCurrency(kpis.lineOfCredit.available)}
          icon={CreditCard}
          hint={`${formatCurrency(kpis.lineOfCredit.used, { compact: true })} drawn of ${formatCurrency(kpis.lineOfCredit.value, { compact: true })}`}
        />
        <StatCard
          label="Weekly Sales"
          value={formatCurrency(kpis.weeklySales.value)}
          icon={TrendingUp}
          change={kpis.weeklySales.change}
          trend={kpis.weeklySales.trend}
          changeLabel="vs prior week"
        />
        <StatCard
          label="Monthly Sales"
          value={formatCurrency(kpis.monthlySales.value)}
          icon={CalendarDays}
          change={kpis.monthlySales.change}
          trend={kpis.monthlySales.trend}
          changeLabel="vs prior month"
        />
        <StatCard
          label="Accounts Receivable"
          value={formatCurrency(kpis.accountsReceivable.value)}
          icon={ArrowDownToLine}
          change={kpis.accountsReceivable.change}
          trend={kpis.accountsReceivable.trend}
          goodDirection="down"
          changeLabel="owed to us"
        />
        <StatCard
          label="Accounts Payable"
          value={formatCurrency(kpis.accountsPayable.value)}
          icon={ArrowUpFromLine}
          change={kpis.accountsPayable.change}
          trend={kpis.accountsPayable.trend}
          goodDirection="down"
          changeLabel="we owe vendors"
        />
        <StatCard
          label="Current Inventory Value"
          value={formatCurrency(kpis.inventoryValue.value)}
          icon={Package}
          change={kpis.inventoryValue.change}
          trend={kpis.inventoryValue.trend}
          changeLabel="at cost"
        />
        <Card className="gap-0 py-0">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Line of Credit Utilization
                </p>
                <p className="mt-2 font-mono text-2xl font-bold text-foreground">
                  {creditUsedPct}%
                </p>
              </div>
              <div className="flex size-10 items-center justify-center rounded-lg bg-secondary text-primary">
                <CreditCard className="size-5" aria-hidden="true" />
              </div>
            </div>
            <Progress value={creditUsedPct} className="mt-4" />
            <p className="mt-2 text-xs text-muted-foreground">Healthy — well below 50% target</p>
          </CardContent>
        </Card>
      </div>

      {/* Health / ratios */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-base">Business Health Score</CardTitle>
            <CardDescription>Composite of liquidity, margin & growth</CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            <RadialStat
              value={kpis.healthScore.value}
              color="var(--chart-1)"
              label={kpis.healthScore.label}
              centerText={String(kpis.healthScore.value)}
            />
            <p className="text-center text-sm text-muted-foreground">
              Up {kpis.healthScore.change} pts this quarter
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-base">Payroll % of Sales</CardTitle>
            <CardDescription>Target ceiling {formatPercent(kpis.payrollPct.target, 0)}</CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            <RadialStat
              value={kpis.payrollPct.value}
              max={50}
              color="var(--chart-3)"
              label="of sales"
              centerText={formatPercent(kpis.payrollPct.value)}
            />
            <p className="text-center text-sm text-muted-foreground">
              Under target by {formatPercent(kpis.payrollPct.target - kpis.payrollPct.value)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-base">Gross Profit %</CardTitle>
            <CardDescription>Target {formatPercent(kpis.grossProfitPct.target, 0)}</CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            <RadialStat
              value={kpis.grossProfitPct.value}
              max={60}
              color="var(--chart-2)"
              label="margin"
              centerText={formatPercent(kpis.grossProfitPct.value)}
            />
            <p className="text-center text-sm text-muted-foreground">
              Above target by {formatPercent(kpis.grossProfitPct.value - kpis.grossProfitPct.target)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 30-day forecast */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">30-Day Cash Forecast</CardTitle>
            <CardDescription>
              Projected daily cash position with minimum operating buffer
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CashForecastChart />
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Sparkles className="size-4" aria-hidden="true" />
              </span>
              <CardTitle className="text-base">AI Advisor Highlights</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            {recommendations.slice(0, 3).map((rec) => (
              <div key={rec.id} className="rounded-lg border border-border p-3">
                <div className="mb-1 flex items-center gap-2">
                  <Badge variant="secondary" className={severityStyles[rec.severity]}>
                    {rec.severity === 'critical' && (
                      <AlertTriangle className="mr-1 size-3" aria-hidden="true" />
                    )}
                    {rec.category}
                  </Badge>
                </div>
                <p className="text-sm font-medium leading-snug text-foreground text-pretty">
                  {rec.title}
                </p>
              </div>
            ))}
            <Button asChild variant="outline" className="mt-auto w-full">
              <Link href="/ai-advisor">
                View all recommendations
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Cash flow */}
      <div className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cash In vs Cash Out</CardTitle>
            <CardDescription>Monthly operating cash flow · trailing 12 months</CardDescription>
          </CardHeader>
          <CardContent>
            <CashFlowChart />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
