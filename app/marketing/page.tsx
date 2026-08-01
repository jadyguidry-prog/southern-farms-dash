import { Megaphone } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { MarketingVerdict } from '@/components/marketing/marketing-verdict'
import { ScenarioExplorer } from '@/components/marketing/scenario-explorer'
import { AffordabilityBreakdown } from '@/components/marketing/affordability-breakdown'
import { MarketingSpendPanel } from '@/components/marketing/marketing-spend-panel'
import { ConfidencePanel } from '@/components/marketing/confidence-panel'
import { MarketingDataFreshness } from '@/components/marketing/marketing-data-freshness'
import { getMarketingAffordabilitySnapshot } from '@/lib/queries'

export const metadata = {
  title: 'Marketing Affordability | Southern Farms',
  description:
    'How much Southern Farms can afford to spend on marketing this month, calculated from real cash, bills and sales history.',
}

export default async function MarketingPage() {
  const data = await getMarketingAffordabilitySnapshot()

  if (!data.hasData) {
    return (
      <div>
        <PageHeader
          title="Marketing Affordability"
          description="How much you can afford to spend on marketing, worked out from real cash rather than a rule of thumb."
        />
        <Card className="gap-0 py-0">
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <Megaphone className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-base font-semibold text-foreground">Not enough data yet</p>
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
              This page needs sales history and current account balances before it can tell you
              anything honest. Add your bank balances under Cash &amp; Debt and sync Square sales,
              then come back.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { metrics } = data

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Marketing Affordability"
        description={`How much you can afford to spend on marketing in ${metrics.targetMonthLabel}, worked out from your real cash, bills and sales history — not a percentage-of-revenue rule of thumb.`}
      />

      {/* Above the verdict on purpose: if the feed is stale, that has to be known
          before the recommended number is read, not after. */}
      <MarketingDataFreshness
        latestTransactionDate={data.dataFreshness.latestTransactionDate}
        daysBehind={data.dataFreshness.daysBehind}
        isStale={data.dataFreshness.isStale}
      />

      <MarketingVerdict
        recommendation={data.recommendation}
        score={data.score}
        recommended={data.budget.recommended}
        currentMonthly={data.spend.typicalMonthly}
        understated={data.uncategorizedMarketing.channels.length > 0}
        targetMonthLabel={metrics.targetMonthLabel}
      />

      <ScenarioExplorer
        scenarios={data.scenarios}
        minCashReserve={data.cash.minCashReserve}
        projectedCash={data.cash.projectedCash}
        daysCashTarget={metrics.daysCashTarget}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AffordabilityBreakdown cash={data.cash} score={data.score} />
        <div className="flex flex-col gap-6">
          <MarketingSpendPanel
            spend={data.spend}
            seasonality={data.seasonality}
            commitmentMismatch={data.commitmentMismatch}
            uncategorizedMarketing={data.uncategorizedMarketing}
            reconciliation={data.reconciliation}
          />
          <ConfidencePanel confidence={data.confidence} />
        </div>
      </div>
    </div>
  )
}
