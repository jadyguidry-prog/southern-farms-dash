import Link from 'next/link'
import {
  Wallet,
  PiggyBank,
  CreditCard,
  ArrowDownToLine,
  ArrowUpFromLine,
  Package,
  CalendarDays,
  TrendingUp,
  Sparkles,
  ArrowRight,
  AlertTriangle,
  Scale,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { CashForecastChart } from '@/components/charts/cash-forecast-chart'
import { CashFlowChart } from '@/components/charts/cash-flow-chart'
import { RadialStat } from '@/components/charts/radial-stat'
import { ReviewNudge } from '@/components/cash-flow/review-nudge'
import { SalesDataStaleness } from '@/components/sales/sales-data-staleness'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { formatCurrency, formatPercent } from '@/lib/data'
import {
  kpi,
  asTrend,
  getCashFlowMonthly,
  getRecommendations,
  getHealthSnapshot,
} from '@/lib/queries'
import { getSpendingCapacity } from '@/lib/spending-capacity-data'
import { getCardExposure } from '@/lib/card-exposure-service'
import { CardExposurePanel } from '@/components/cards/card-exposure-panel'
import { HEALTH_COLOR, HEALTH_TEXT } from '@/lib/health'
// Reused rather than adding a second month formatter, so the Gross Profit card
// labels months identically to the cash-flow chart beside it.
import { monthLabel } from '@/lib/cash-flow-service'

const severityStyles: Record<string, string> = {
  critical: 'bg-destructive/10 text-destructive',
  warning: 'bg-chart-4/15 text-chart-4',
  opportunity: 'bg-primary/10 text-primary',
}

export default async function DashboardPage() {
  const [snapshot, capacity, cashFlowMonthly, saved, cardExposure] = await Promise.all([
    getHealthSnapshot(),
    getSpendingCapacity(),
    getCashFlowMonthly(),
    getRecommendations(),
    getCardExposure(),
  ])

  const {
    kpis,
    settings,
    pillars,
    composite,
    insights,
    cashFlow,
    labor,
    checks,
    marketing,
    billPay,
    growthPlanner,
    proposalReviews,
  } =
    snapshot
  // Saved proposals whose live verdict no longer matches the one recorded at save
  // time. Counted from the same shared review the advisor uses, so the card and the
  // advisor can never report a different number of changed proposals.
  const changedProposalCount = proposalReviews.filter((r) => r.changed).length
  // Generated insights lead, followed by anything entered manually.
  //
  // Sorted by severity because the highlights card shows only the first three. On
  // raw insertion order a critical finding could be cut off entirely while three
  // "on target" notes filled the card — the opposite of a highlight. `sort` is
  // stable, so equal-severity items keep their previous relative order.
  const severityRank = { critical: 0, warning: 1, opportunity: 2 } as const
  const recommendations = [...insights, ...saved].sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity],
  )

  // Prefer cash flow derived from real bank transactions; the legacy
  // cash_flow_monthly table is empty and has no year column to order by.
  const derivedCashFlow = cashFlow.monthly.series
  const cashFlowData =
    derivedCashFlow.length > 0
      ? derivedCashFlow.map((m) => ({
          month: m.month,
          inflow: m.inflow,
          outflow: m.outflow,
          complete: m.complete,
        }))
      : cashFlowMonthly
  // Last FINISHED month, so the headline is a real month's result. The
  // still-running month is shown alongside it rather than hidden, because
  // dropping it would leave the owner wondering where the current month went —
  // but it is labelled "so far" so it can't be read as a monthly outcome.
  const latestComplete = cashFlow.monthly.latestCompleteMonth
  const monthInProgress = cashFlow.monthly.monthInProgress

  const cashOnHand = kpi(kpis, 'cashOnHand')
  // When checks are written but not yet cleared, the bank balance overstates
  // what can actually be spent. Surface the spendable figure right on the tile
  // rather than in a separate card, so the two numbers are never read apart.
  // Derived from the tile's own cashOnHand value so the subtraction is visibly
  // consistent with the number shown above it.
  const cashHint =
    billPay.outstandingCheckCount > 0
      ? `${formatCurrency(cashOnHand.value - billPay.outstandingChecks)} spendable after ${
          billPay.outstandingCheckCount
        } outstanding ${billPay.outstandingCheckCount === 1 ? 'check' : 'checks'}`
      : undefined
  // The "Safe to Spend" hint.
  //
  // The headline figure only looks at the near-term window, so a card payment due later in
  // the month is NOT reflected in it. That payment has to be named right here: this tile is
  // the screen decisions get made on, and an unqualified number (whether a surplus or a
  // bare $0) hides the single largest thing about to leave the account.
  const spendHint = (() => {
    const dueLater = [...capacity.cardPayments]
      .filter((p) => p.dueDate > capacity.today)
      .sort((a, b) => b.amount - a.amount)[0]
    const dueLaterNote = dueLater
      ? ` · ${formatCurrency(dueLater.amount)} card payment due ${new Date(
          `${dueLater.dueDate}T00:00:00`,
        ).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : ''

    // At or below the reserve there is no allowance to quote, but the upcoming payment is
    // still the most important fact — arguably more so, since there is no cushion for it.
    if (capacity.safeToSpendToday <= 0) {
      return `Cash is at or below your ${formatCurrency(capacity.minCashReserve)} reserve${dueLaterNote}`
    }

    const pace = `≈ ${formatCurrency(capacity.perDayAllowance)}/day for ${capacity.nearTermDays} days`

    if (capacity.breachesReserve) {
      return `${pace} · ${formatCurrency(capacity.reserveShortfall)} short of your reserve by ${new Date(
        `${capacity.lowestBalanceDate}T00:00:00`,
      ).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${dueLaterNote}`
    }

    return `${pace} · keeps ${formatCurrency(capacity.minCashReserve)} reserve${dueLaterNote}`
  })()

  const lineOfCredit = kpi(kpis, 'lineOfCredit')
  const accountsReceivable = kpi(kpis, 'accountsReceivable')
  const accountsPayable = kpi(kpis, 'accountsPayable')
  const inventoryValue = kpi(kpis, 'inventoryValue')
  const weeklySales = kpi(kpis, 'weeklySales')
  const monthlySales = kpi(kpis, 'monthlySales')
  const payrollPct = kpi(kpis, 'payrollPct')
  // Gross margin is DERIVED from the check-resolution snapshot, not read from a
  // stored KPI. There is no `grossProfitPct` row in `kpis`, so `kpi()` returned
  // the 0 fallback: the gauge would have drawn 0.0% and declared "Below target by
  // 38%" the moment the readiness gate opened — a confident verdict built from an
  // absent row. Reading the snapshot also means this card and the Reporting table
  // are computed from one function and cannot disagree.
  const quotableMonth = checks.latestQuotableMonth

  // Monthly sales provenance. The Square feed usually lags the calendar by a few
  // days, so the card names the month and says how far through it the figure
  // runs — otherwise a part-month total reads as a full month that fell short.
  const monthlySalesThrough = String(monthlySales.meta.throughDate ?? '')
  const monthlySalesComplete = Number(monthlySales.meta.monthComplete ?? 0) === 1
  const monthlySalesMonthLabel = monthlySalesThrough
    ? new Date(`${monthlySalesThrough}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'short',
        year: '2-digit',
        timeZone: 'UTC',
      })
    : null
  const monthlySalesHint = monthlySalesThrough
    ? monthlySalesComplete
      ? `Full month · ${monthlySales.meta.transactionCount ?? 0} transactions`
      : `Month to date through ${new Date(
          `${monthlySalesThrough}T00:00:00Z`,
        ).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        })} · ${monthlySales.meta.daysCovered ?? 0} days of sales`
    : undefined

  // Weekly card provenance. The card reports the CALENDAR week so far, while the
  // sales health pillar judges a full trailing 7 days against the weekly goal and
  // floor. Both are named on the card: showing week-to-date beside a pillar verdict
  // derived from a different window reads as a contradiction unless each window is
  // stated. `hasData` distinguishes "no day of this week has synced yet" from a
  // genuine zero, so the card never prints $0 for an unrecorded week.
  const weeklyHasData = Number(weeklySales.meta.hasData ?? 0) === 1
  const weeklyDaysCovered = Number(weeklySales.meta.daysCovered ?? 0)
  const weeklyTrailing = Number(weeklySales.meta.trailingSevenDay ?? 0)
  // Kept short enough to survive StatCard's `truncate`: the pillar label is
  // deliberately omitted because it already appears in Business Health below and
  // on the advisor, whereas the 7-day figure appears nowhere else on this card
  // and is what reconciles the headline with the weekly floor.
  const weeklyHint = weeklyHasData
    ? `${weeklyDaysCovered} ${weeklyDaysCovered === 1 ? 'day' : 'days'} in · 7-day ${formatCurrency(weeklyTrailing, { compact: true })} vs ${formatCurrency(settings.minimum_weekly_sales, { compact: true })} floor`
    : `Nothing recorded yet · 7-day ${formatCurrency(weeklyTrailing, { compact: true })} vs ${formatCurrency(settings.minimum_weekly_sales, { compact: true })} floor`

  const locTotal = lineOfCredit.value
  const locUsed = Number(lineOfCredit.meta.used ?? 0)
  const locAvailable = Number(lineOfCredit.meta.available ?? Math.max(locTotal - locUsed, 0))
  const creditUsedPct = locTotal ? Math.round((locUsed / locTotal) * 100) : 0
  // Owner-defined thresholds from Admin → Business Settings.
  const payrollTarget = settings.target_payroll_pct
  const payrollWarning = settings.warning_payroll_pct
  const payrollOverTarget = payrollPct.value - payrollTarget
  const gpTarget = settings.target_gross_profit_pct

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Good morning — here's your business at a glance"
        description="Southern Farms Specialty Meats · Fiscal Year 2026. A real-time view of cash, credit, receivables, and operating performance."
      />

      {/* Above the KPIs on purpose: if the sales figures below are incomplete,
          that has to be known before they are read, not after. */}
      <SalesDataStaleness throughDate={monthlySalesThrough} className="mb-6" />

      <ReviewNudge insight={cashFlow} className="mb-6" />

      {/* Primary KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Cash on Hand"
          value={formatCurrency(cashOnHand.value)}
          icon={Wallet}
          change={cashOnHand.change ?? undefined}
          trend={asTrend(cashOnHand.trend)}
          changeLabel="vs last month"
          hint={cashHint}
        />
        {/* Placed directly after Cash on Hand because it qualifies it: cash on
            hand is not spendable cash. Only shown once the engine has enough
            history to stand behind a figure — a guess here would be acted on. */}
        {capacity.confidence.level === 'ok' && (
          <StatCard
            label="Safe to Spend Today"
            value={formatCurrency(capacity.safeToSpendToday)}
            icon={PiggyBank}
            hint={spendHint}
          />
        )}
        <StatCard
          label="Available Line of Credit"
          value={formatCurrency(locAvailable)}
          icon={CreditCard}
          hint={`${formatCurrency(locUsed, { compact: true })} drawn of ${formatCurrency(locTotal, { compact: true })}`}
        />
        <StatCard
          label="Sales — Week to Date"
          value={weeklyHasData ? formatCurrency(weeklySales.value) : 'Not recorded yet'}
          icon={TrendingUp}
          change={weeklySales.change ?? undefined}
          trend={asTrend(weeklySales.trend)}
          changeLabel="vs same days last week"
          hint={weeklyHint}
        />
        <StatCard
          label={
            monthlySalesMonthLabel
              ? `Monthly Sales — ${monthlySalesMonthLabel}`
              : 'Monthly Sales'
          }
          value={formatCurrency(monthlySales.value)}
          icon={CalendarDays}
          change={monthlySales.change ?? undefined}
          trend={asTrend(monthlySales.trend)}
          changeLabel={
            monthlySalesComplete ? 'vs prior month' : 'vs prior month, same period'
          }
          hint={monthlySalesHint}
        />
        <StatCard
          label="Accounts Receivable"
          value={formatCurrency(accountsReceivable.value)}
          icon={ArrowDownToLine}
          change={accountsReceivable.change ?? undefined}
          trend={asTrend(accountsReceivable.trend)}
          goodDirection="down"
          // A `hint`, not a `changeLabel`: "owed to us" describes the value on its
          // own and must show whether or not a month-over-month change exists.
          // changeLabel is reserved for text that only makes sense beside a
          // percentage ("vs last month"), which is now gated on having one.
          hint="owed to us"
        />
        <StatCard
          label="Accounts Payable"
          value={formatCurrency(accountsPayable.value)}
          icon={ArrowUpFromLine}
          change={accountsPayable.change ?? undefined}
          trend={asTrend(accountsPayable.trend)}
          goodDirection="down"
          hint="we owe vendors"
        />
        <StatCard
          label="Current Inventory Value"
          value={formatCurrency(inventoryValue.value)}
          icon={Package}
          change={inventoryValue.change ?? undefined}
          trend={asTrend(inventoryValue.trend)}
          hint="at cost"
        />
        {/* Actual money in vs out for the last FINISHED month with a full
            picture. Rendered only when real transactions exist — a month
            missing its deposit account would read as a loss rather than as
            missing data, and an in-progress month as an overspend. */}
        {latestComplete && (
          <StatCard
            label={`Net Cash Movement — ${latestComplete.month}`}
            value={formatCurrency(latestComplete.net)}
            icon={Scale}
            hint={`${formatCurrency(latestComplete.inflow, { compact: true })} in · ${formatCurrency(latestComplete.outflow, { compact: true })} out${
              monthInProgress
                ? ` · ${monthInProgress.month} so far ${formatCurrency(monthInProgress.net, { compact: true })}`
                : ''
            }`}
          />
        )}
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

      {/* Credit card exposure sits directly under the line-of-credit card because
          both are borrowed money. It was previously invisible on every surface:
          totalDebt counts loans only, and card balances lived in creditDrawn,
          which this page never displayed. Card spend running $3.3k-$11.2k/month
          was therefore absent from the dashboard entirely. */}
      <CardExposurePanel exposure={cardExposure} className="mt-4" />

      {/* Health / ratios */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-base">Business Health Score</CardTitle>
            <CardDescription>Cash reserve, payroll & weekly sales vs your targets</CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            <RadialStat
              value={composite.score ?? 0}
              color={HEALTH_COLOR[composite.status]}
              label={composite.label}
              centerText={composite.score === null ? '—' : String(composite.score)}
            />
            <p className="text-center text-sm text-muted-foreground">
              {composite.score === null
                ? 'Add your data to generate a score'
                : `${composite.measured} of ${composite.total} measures scored`}
            </p>
            <ul className="mt-3 space-y-1">
              {(
                [
                  ['Cash', pillars.cash],
                  ['Payroll', pillars.payroll],
                  ['Sales', pillars.sales],
                ] as const
              ).map(([name, p]) => (
                <li key={name} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{name}</span>
                  <span className={`font-medium ${HEALTH_TEXT[p.status]}`}>{p.label}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-base">Payroll % of Sales</CardTitle>
            <CardDescription>
              {labor.monthLabel ? `${labor.monthLabel} · ` : ''}target{' '}
              {formatPercent(payrollTarget, 0)} · warning above{' '}
              {formatPercent(payrollWarning, 0)}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            <RadialStat
              value={payrollPct.value}
              max={30}
              color={HEALTH_COLOR[pillars.payroll.status]}
              label="of sales"
              centerText={formatPercent(payrollPct.value)}
            />
            <p className="text-center text-sm text-muted-foreground">
              {payrollPct.value <= 0
                ? 'No timecard data yet'
                : payrollOverTarget > 0
                  ? `Over target by ${formatPercent(payrollOverTarget)}`
                  : `Under target by ${formatPercent(Math.abs(payrollOverTarget))}`}
            </p>
            {/* A headline month under target while the recent run is over it is
                not a win — say so on the card, not just in the advisor. */}
            {payrollPct.value > 0 &&
            payrollOverTarget <= 0 &&
            labor.rolling3.laborPct != null &&
            labor.rolling3.laborPct >= payrollTarget ? (
              <p className={`text-center text-xs ${HEALTH_TEXT.yellow}`}>
                but the last {labor.rolling3.monthsCounted} months averaged over
                target
              </p>
            ) : null}
            {/* The gauge is one month. These two windows say whether that month
                is a blip or the direction of travel. */}
            {labor.hasData && labor.rolling3.laborPct != null ? (
              <dl className="mt-3 flex justify-center gap-6 border-t pt-3 text-center">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Last {labor.rolling3.monthsCounted} mo
                  </dt>
                  {/* Colored against the same target as the gauge. Without this
                      the headline can read "under target" while the recent run
                      is over it — the exact thing showing three windows is for. */}
                  <dd
                    className={`text-sm font-medium tabular-nums ${
                      labor.rolling3.laborPct >= payrollWarning
                        ? HEALTH_TEXT.red
                        : labor.rolling3.laborPct >= payrollTarget
                          ? HEALTH_TEXT.yellow
                          : ''
                    }`}
                  >
                    {formatPercent(labor.rolling3.laborPct)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    All {labor.allTime.monthsCounted} mo
                  </dt>
                  <dd className="text-sm font-medium tabular-nums">
                    {labor.allTime.laborPct == null
                      ? '—'
                      : formatPercent(labor.allTime.laborPct)}
                  </dd>
                </div>
              </dl>
            ) : null}
            {labor.hasData && labor.unpricedHours > 0 ? (
              <p className="mt-2 text-center text-xs text-muted-foreground">
                At least — {Math.round(labor.unpricedHours).toLocaleString()} h
                have no wage on file.{' '}
                <Link href="/payroll" className="underline">
                  Review
                </Link>
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-base">Gross Profit %</CardTitle>
            <CardDescription>Target {formatPercent(gpTarget, 0)}</CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            {/*
              The gauge is drawn from the newest month that passes EVERY guard —
              complete sales, imported bank data, categorized COGS and no
              unattributed checks — rather than from the business-wide readiness
              flag. A single clean month is a real, defensible figure even while
              older months are still being attributed; the alternative was
              withholding a true number until the entire history was perfect.
              The month is named so a figure from an older month can never be
              read as the current one.
            */}
            {quotableMonth?.marginPct != null ? (
              <>
                <RadialStat
                  value={quotableMonth.marginPct}
                  max={60}
                  /*
                    Colored by the verdict, matching the payroll gauge beside it.
                    It was pinned to a fixed red, so a margin 11.4% ABOVE target
                    drew as an alarm while the caption underneath read "Above
                    target" — the dial and the words disagreed.
                  */
                  color={
                    HEALTH_COLOR[
                      quotableMonth.marginPct >= gpTarget
                        ? 'green'
                        : quotableMonth.marginPct >= gpTarget - 5
                          ? 'yellow'
                          : 'red'
                    ]
                  }
                  label="margin"
                  centerText={formatPercent(quotableMonth.marginPct)}
                />
                <p className="text-center text-sm text-muted-foreground">
                  {quotableMonth.marginPct >= gpTarget
                    ? `Above target by ${formatPercent(quotableMonth.marginPct - gpTarget)}`
                    : `Below target by ${formatPercent(gpTarget - quotableMonth.marginPct)}`}
                </p>
                <p className="text-center text-xs text-muted-foreground">
                  {monthLabel(quotableMonth.month)} ·{' '}
                  {formatCurrency(quotableMonth.netSales)} sales less{' '}
                  {formatCurrency(quotableMonth.totalCogs)} cost of goods
                </p>
                {/* A clean month inside an otherwise unresolved record needs the
                    caveat attached, or it reads as a verdict on the business. */}
                {!checks.readiness.ready ? (
                  <p className="mt-1 text-pretty text-center text-xs text-muted-foreground">
                    This month is fully attributed. Other months still have{' '}
                    {formatCurrency(checks.progress.pendingAmount)} of
                    unattributed checks, so this is not yet a trend.
                  </p>
                ) : null}
              </>
            ) : (
              <div className="flex min-h-[180px] flex-col justify-center gap-2 text-center">
                <p className="text-2xl font-semibold text-muted-foreground">
                  Not yet measurable
                </p>
                {/*
                  Name the reason that actually applies. Unattributed checks are
                  the usual cause, but a month can also be unmeasurable because
                  its bank statements were never imported — and pointing the
                  owner at Check Resolution for THAT would be the wrong job
                  entirely.
                */}
                {checks.progress.pendingCount > 0 ? (
                  <>
                    <p className="text-pretty text-sm text-muted-foreground">
                      {checks.progress.pendingCount.toLocaleString()} check
                      payments worth{' '}
                      {formatCurrency(checks.progress.pendingAmount)} have no
                      payee, so cost of goods is incomplete
                      {checks.readiness.unresolvedVsCogsRatio != null
                        ? ` — ${checks.readiness.unresolvedVsCogsRatio.toFixed(1)}x the ${formatCurrency(checks.readiness.identifiedCogs)} identified`
                        : ''}
                      . A margin now would overstate profit.
                    </p>
                    <Link
                      href="/check-resolution"
                      className="text-sm font-medium underline"
                    >
                      Resolve checks
                    </Link>
                  </>
                ) : checks.monthsMissingBankData.length > 0 ? (
                  <p className="text-pretty text-sm text-muted-foreground">
                    {checks.monthsMissingBankData.length}{' '}
                    {checks.monthsMissingBankData.length === 1
                      ? 'month has'
                      : 'months have'}{' '}
                    sales but no bank transactions imported, so their cost of
                    goods is a fragment of what was really spent. Importing those
                    statements is what makes a margin measurable.
                  </p>
                ) : (
                  <p className="text-pretty text-sm text-muted-foreground">
                    No month yet has complete sales, imported bank data and
                    categorized cost of goods together, so any margin would be
                    built on partial records.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Marketing affordability + growth capacity, side by side: both answer
          "what can this business afford to commit to", at different scopes. */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">Marketing Budget</CardTitle>
                <CardDescription>
                  What cash can support after the reserve, bills and payroll
                </CardDescription>
              </div>
              {marketing.hasData ? (
                <Badge variant="secondary">{marketing.score.band}</Badge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {/* Same honesty rule as Gross Profit above: with no transactions or
                revenue history there is nothing to base a budget on, so say so
                rather than rendering a confident $0. */}
            {!marketing.hasData ? (
              <div className="flex flex-col gap-2">
                <p className="text-lg font-semibold text-muted-foreground">
                  Not yet measurable
                </p>
                <p className="text-pretty text-sm text-muted-foreground">
                  A marketing budget needs imported bank transactions and monthly
                  revenue history. Without both, any figure here would be a guess.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-3xl font-semibold tracking-tight">
                    {formatCurrency(marketing.budget.recommended)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    per month recommended
                  </span>
                </div>
                <p className="text-pretty text-sm text-muted-foreground">
                  {marketing.recommendation.summary}
                </p>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  <span className="text-muted-foreground">
                    Currently{' '}
                    <span className="font-medium text-foreground">
                      {formatCurrency(
                        Math.max(
                          marketing.committedMonthly,
                          marketing.spend.avg3Month,
                        ),
                      )}
                      /mo
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    Safe headroom{' '}
                    <span className="font-medium text-foreground">
                      {formatCurrency(marketing.additionalSafe)}
                    </span>
                  </span>
                </div>
                <Link
                  href="/marketing"
                  className="text-sm font-medium underline"
                >
                  See how this is calculated
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Growth capacity. Reads the SAME snapshot the Growth Planner page uses,
            so the headline figure here can never contradict that page. */}
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">Growth Investment</CardTitle>
                <CardDescription>
                  What a new commitment can be, tested against a downturn
                </CardDescription>
              </div>
              {growthPlanner.hasData ? (
                <Badge variant="secondary">{growthPlanner.activeMode.label}</Badge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {!growthPlanner.hasData ? (
              <div className="flex flex-col gap-2">
                <p className="text-lg font-semibold text-muted-foreground">
                  Not yet measurable
                </p>
                <p className="text-pretty text-sm text-muted-foreground">
                  Planning a new commitment needs imported bank transactions and
                  revenue history. Without both, any figure here would be a guess.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-3xl font-semibold tracking-tight">
                    {formatCurrency(growthPlanner.maxRecurring)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    per month recommended
                  </span>
                </div>
                {/* The headline is the STRESSED figure. Saying so on the card matters:
                    without it, this number and the higher ceiling on the planner page
                    look like a contradiction rather than two different standards. */}
                <p className="text-pretty text-sm text-muted-foreground">
                  {growthPlanner.maxRecurring > 0
                    ? `Still clears every limit even if sales fell ${growthPlanner.activeMode.headlineStressSalesDeclinePct}%.`
                    : growthPlanner.edgeRecurring > 0
                      ? `Nothing survives a ${growthPlanner.activeMode.headlineStressSalesDeclinePct}% sales drop. If sales held exactly as expected your limits would tolerate about ${formatCurrency(growthPlanner.edgeRecurring)} a month — but that is not a recommendation.`
                      : 'Your current cash and obligations leave no room for new recurring spending yet.'}
                </p>
                {growthPlanner.maxRecurring > 0 ? (
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    <span className="text-muted-foreground">
                      One-time{' '}
                      <span className="font-medium text-foreground">
                        {formatCurrency(growthPlanner.maxOneTime)}
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      Ceiling{' '}
                      <span className="font-medium text-foreground">
                        {formatCurrency(growthPlanner.edgeRecurring)}/mo
                      </span>
                    </span>
                  </div>
                ) : null}
                {/* A saved proposal whose answer moved is the most actionable thing
                    on this card, so it outranks the figures above it. */}
                {changedProposalCount > 0 ? (
                  <p className="text-pretty text-sm font-medium text-amber-700">
                    {changedProposalCount === 1
                      ? '1 saved proposal has a different answer than when you saved it.'
                      : `${changedProposalCount} saved proposals have different answers than when you saved them.`}
                  </p>
                ) : null}
                <Link href="/growth" className="text-sm font-medium underline">
                  Open the Growth Planner
                </Link>
              </div>
            )}
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
            <CashForecastChart
              data={capacity.thirtyDay}
              minBuffer={capacity.minCashReserve}
              showCautious
            />
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
            {cashFlowData.length > 0 ? (
              <CashFlowChart data={cashFlowData} />
            ) : (
              <div className="flex h-[300px] items-center justify-center">
                <p className="max-w-xs text-center text-sm text-muted-foreground text-pretty">
                  No bank transactions imported yet. Import statements from the
                  Vendors page to see monthly cash in and out.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
