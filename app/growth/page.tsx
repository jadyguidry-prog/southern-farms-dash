import { TrendingUp } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { MarketingDataFreshness } from '@/components/marketing/marketing-data-freshness'
import { GrowthVerdict } from '@/components/growth/growth-verdict'
import { RiskModeSelector } from '@/components/growth/risk-mode-selector'
import { CapacityLadder } from '@/components/growth/capacity-ladder'
import { ProjectionTable } from '@/components/growth/projection-table'
import { ScenarioMatrix } from '@/components/growth/scenario-matrix'
import { ConstraintsPanel } from '@/components/growth/constraints-panel'
import { getGrowthPlannerSnapshot } from '@/lib/growth-planner-service'

export const metadata = {
  title: 'Growth Planner | Southern Farms',
  description:
    'What Southern Farms can afford to take on — recurring or one-time — judged against real cash, bills and your own risk limits.',
}

/** `2026-09` -> `September 2026`. Built from parts to avoid timezone drift. */
function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  if (!y || !m) return key
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** Parse a positive money value from a query string, or null. */
function parseAmount(raw: string | string[] | undefined): number | null {
  if (typeof raw !== 'string') return null
  const n = Number(raw.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

export default async function GrowthPage({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>
}) {
  // Next.js 16: searchParams is async and must be awaited.
  const sp = await searchParams

  const data = await getGrowthPlannerSnapshot({
    modeKey: typeof sp.mode === 'string' ? sp.mode : undefined,
    customRecurring: parseAmount(sp.monthly),
    customOneTime: parseAmount(sp.once),
  })

  if (!data.hasData) {
    return (
      <div>
        <PageHeader
          title="Growth Planner"
          description="What you can afford to take on, judged against your real cash rather than a rule of thumb."
        />
        <Card className="gap-0 py-0">
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <TrendingUp className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-base font-semibold text-foreground">Not enough data yet</p>
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
              This needs your account balances and some sales history before it can say
              anything honest. Add your balances under Cash &amp; Debt and sync your
              sales, then come back.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Growth Planner"
        description="What you can afford to take on — a monthly cost or a one-off purchase — worked out from your real cash, bills and the limits you set."
      />

      {/* Above the verdict deliberately: if the data is stale, that must be known
          before the number is read, not after. */}
      <MarketingDataFreshness
        latestTransactionDate={data.meta.dataFreshness.latestTransactionDate}
        daysBehind={data.meta.dataFreshness.daysBehind}
        isStale={data.meta.dataFreshness.isStale}
      />

      <GrowthVerdict
        maxRecurring={data.maxRecurring}
        maxOneTime={data.maxOneTime}
        edgeRecurring={data.edgeRecurring}
        edgeOneTime={data.edgeOneTime}
        mode={data.activeMode}
        baseline={data.baselineEvaluation}
        minCashReserve={data.meta.minCashReserve}
        horizonMonths={data.meta.horizonMonths}
        startMonthLabel={monthLabel(data.meta.startMonthKey)}
      />

      <RiskModeSelector
        modes={data.modes}
        activeModeKey={data.activeMode.modeKey}
        minCashReserve={data.meta.minCashReserve}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CapacityLadder ladder={data.ladder} />
        <div className="flex flex-col gap-6">
          <ProjectionTable
            baseline={data.baseline}
            reserveFloor={data.baselineEvaluation.reserveFloor}
            lowestMonthKey={data.baselineEvaluation.lowestMonthKey}
          />
          <ScenarioMatrix
            scenarios={data.scenarios}
            commitment={data.stressCommitment}
            modeLabel={data.activeMode.label}
          />
          <ConstraintsPanel
            strategy={data.strategy}
            cards={data.cards}
            confidencePct={data.meta.confidencePct}
            confidenceGaps={data.meta.confidenceGaps}
          />
        </div>
      </div>
    </div>
  )
}
