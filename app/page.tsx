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
import { formatCurrency, formatPercent } from '@/lib/data'
import {
  getKpis,
  kpi,
  asTrend,
  getCashForecast,
  getCashFlowMonthly,
  getRecommendations,
  getBusinessSettings,
} from '@/lib/queries'

const severityStyles: Record<string, string> = {
  critical: 'bg-destructive/10 text-destructive',
  warning: 'bg-chart-4/15 text-chart-4',
  opportunity: 'bg-primary/10 text-primary',
}

export default async function DashboardPage() {
  const [kpis, cashForecast, cashFlowMonthly, recommendations, settings] =
    await Promise.all([
      getKpis(),
      getCashForecast(),
      getCashFlowMonthly(),
      getRecommendations(),
      getBusinessSettings(),
    ])

  const cashOnHand = kpi(kpis, 'cashOnHand')
  const lineOfCredit = kpi(kpis, 'lineOfCredit')
  const accountsReceivable = kpi(kpis, 'accountsReceivable')
  const accountsPayable = kpi(kpis, 'accountsPayable')
  const inventoryValue = kpi(kpis, 'inventoryValue')
  const healthScore = kpi(kpis, 'healthScore')
  const weeklySales = kpi(kpis, 'weeklySales')
  const monthlySales = kpi(kpis, 'monthlySales')
  const payrollPct = kpi(kpis, 'payrollPct')
  const grossProfitPct = kpi(kpis, 'grossProfitPct')

  const locTotal = lineOfCredit.value
  const locUsed = Number(lineOfCredit.meta.used ?? 0)
  const locAvailable = Number(lineOfCredit.meta.available ?? Math.max(locTotal - locUsed, 0))
  const creditUsedPct = locTotal ? Math.round((locUsed / locTotal) * 100) : 0
  // Owner-defined thresholds from Admin → Business Settings.
  const payrollTarget = settings.target_payroll_pct
  const payrollWarning = settings.warning_payroll_pct
  const payrollOverTarget = payrollPct.value - payrollTarget
  const gpTarget = Number(grossProfitPct.meta.target ?? 38)

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
          value={formatCurrency(cashOnHand.value)}
          icon={Wallet}
          change={cashOnHand.change ?? undefined}
          trend={asTrend(cashOnHand.trend)}
          changeLabel="vs last month"
        />
        <StatCard
          label="Available Line of Credit"
          value={formatCurrency(locAvailable)}
          icon={CreditCard}
          hint={`${formatCurrency(locUsed, { compact: true })} drawn of ${formatCurrency(locTotal, { compact: true })}`}
        />
        <StatCard
          label="Weekly Sales"
          value={formatCurrency(weeklySales.value)}
          icon={TrendingUp}
          change={weeklySales.change ?? undefined}
          trend={asTrend(weeklySales.trend)}
          changeLabel="vs prior week"
          hint={`Goal ${formatCurrency(settings.preferred_weekly_sales)} · floor ${formatCurrency(settings.minimum_weekly_sales)}`}
        />
        <StatCard
          label="Monthly Sales"
          value={formatCurrency(monthlySales.value)}
          icon={CalendarDays}
          change={monthlySales.change ?? undefined}
          trend={asTrend(monthlySales.trend)}
          changeLabel="vs prior month"
        />
        <StatCard
          label="Accounts Receivable"
          value={formatCurrency(accountsReceivable.value)}
          icon={ArrowDownToLine}
          change={accountsReceivable.change ?? undefined}
          trend={asTrend(accountsReceivable.trend)}
          goodDirection="down"
          changeLabel="owed to us"
        />
        <StatCard
          label="Accounts Payable"
          value={formatCurrency(accountsPayable.value)}
          icon={ArrowUpFromLine}
          change={accountsPayable.change ?? undefined}
          trend={asTrend(accountsPayable.trend)}
          goodDirection="down"
          changeLabel="we owe vendors"
        />
        <StatCard
          label="Current Inventory Value"
          value={formatCurrency(inventoryValue.value)}
          icon={Package}
          change={inventoryValue.change ?? undefined}
          trend={asTrend(inventoryValue.trend)}
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
            <p className="mt-2 text-xs text-muted-foreground">
              {creditUsedPct <= 50
                ? 'Healthy — at or below the 50% target'
                : `Above the 50% target — ${formatCurrency(locUsed)} drawn`}
            </p>
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
              value={healthScore.value}
              color="var(--chart-1)"
              label={String(healthScore.meta.label ?? 'Score')}
              centerText={String(healthScore.value)}
            />
            <p className="text-center text-sm text-muted-foreground">
              {healthScore.change ? `Up ${healthScore.change} pts this quarter` : 'Composite score'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-base">Payroll % of Sales</CardTitle>
            <CardDescription>
              Target {formatPercent(payrollTarget, 0)} · warning above{' '}
              {formatPercent(payrollWarning, 0)}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            <RadialStat
              value={payrollPct.value}
              max={30}
              color={
                payrollPct.value > payrollWarning
                  ? 'var(--destructive)'
                  : payrollPct.value > payrollTarget
                    ? 'var(--chart-4)'
                    : 'var(--chart-3)'
              }
              label="of sales"
              centerText={formatPercent(payrollPct.value)}
            />
            <p className="text-center text-sm text-muted-foreground">
              {payrollOverTarget > 0
                ? `Over target by ${formatPercent(payrollOverTarget)}`
                : `Under target by ${formatPercent(Math.abs(payrollOverTarget))}`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-base">Gross Profit %</CardTitle>
            <CardDescription>Target {formatPercent(gpTarget, 0)}</CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            <RadialStat
              value={grossProfitPct.value}
              max={60}
              color="var(--chart-2)"
              label="margin"
              centerText={formatPercent(grossProfitPct.value)}
            />
            <p className="text-center text-sm text-muted-foreground">
              {grossProfitPct.value >= gpTarget
                ? `Above target by ${formatPercent(grossProfitPct.value - gpTarget)}`
                : `Below target by ${formatPercent(gpTarget - grossProfitPct.value)}`}
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
            <CashForecastChart data={cashForecast} />
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
            {recommendations.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No recommendations yet. Add data in the Admin panel to generate insights.
              </p>
            )}
            <Button
              render={<Link href="/ai-advisor" />}
              nativeButton={false}
              variant="outline"
              className="mt-auto w-full"
            >
              View all recommendations
              <ArrowRight className="size-4" />
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
            <CashFlowChart data={cashFlowMonthly} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
