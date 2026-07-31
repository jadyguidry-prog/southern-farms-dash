import { AlertTriangle, ArrowDownRight, ArrowUpRight, MinusCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/data'
import type {
  AffordabilityScore,
  MarketingRecommendation,
} from '@/lib/marketing-affordability-service'

/**
 * The answer, before any of the supporting detail.
 *
 * This sits at the top because the owner's actual question is "how much can I
 * spend" — the workings matter, but only after the number.
 */

const ACTION_ICON = {
  increase: ArrowUpRight,
  hold: MinusCircle,
  reduce: ArrowDownRight,
  stop: AlertTriangle,
} as const

/** Score band drives the accent. Red is reserved for a genuine cash problem. */
const BAND_STYLE: Record<string, { badge: string; bar: string }> = {
  Excellent: { badge: 'border-transparent bg-emerald-600 text-white', bar: 'bg-emerald-600' },
  Healthy: { badge: 'border-transparent bg-emerald-600 text-white', bar: 'bg-emerald-600' },
  Watch: { badge: 'border-transparent bg-amber-500 text-white', bar: 'bg-amber-500' },
  Limited: { badge: 'border-transparent bg-amber-600 text-white', bar: 'bg-amber-600' },
  'Do Not Increase': { badge: 'border-transparent bg-destructive text-white', bar: 'bg-destructive' },
}

export function MarketingVerdict({
  recommendation,
  score,
  recommended,
  currentMonthly,
  targetMonthLabel,
}: {
  recommendation: MarketingRecommendation
  score: AffordabilityScore
  recommended: number
  currentMonthly: number
  targetMonthLabel: string
}) {
  const Icon = ACTION_ICON[recommendation.action]
  const style = BAND_STYLE[score.band] ?? BAND_STYLE.Watch

  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-6 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
              <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Recommended marketing budget for {targetMonthLabel}
              </p>
            </div>
            <p className="font-mono text-4xl font-bold tracking-tight text-foreground">
              {formatCurrency(recommended)}
              <span className="ml-1 font-sans text-base font-medium text-muted-foreground">
                /month
              </span>
            </p>
            <p className="max-w-2xl text-sm leading-relaxed text-foreground text-pretty">
              {recommendation.summary}
            </p>
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            <Badge className={style.badge}>{score.band}</Badge>
            <div className="flex items-baseline gap-1">
              <span className="font-mono text-2xl font-bold text-foreground">{score.score}</span>
              <span className="text-sm text-muted-foreground">/100 capacity</span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted sm:w-40"
              role="meter"
              aria-valuenow={score.score}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Marketing capacity score"
            >
              <div className={`h-full ${style.bar}`} style={{ width: `${score.score}%` }} />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 border-t border-border pt-5 sm:flex-row sm:gap-8">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Spending now
            </p>
            <p className="mt-1 font-mono text-lg font-semibold text-foreground">
              {formatCurrency(currentMonthly)}
              <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">/mo</span>
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Change
            </p>
            <p className="mt-1 font-mono text-lg font-semibold text-foreground">
              {recommendation.action === 'increase' ? '+' : recommendation.amount > 0 ? '-' : ''}
              {formatCurrency(Math.abs(recommendation.amount))}
            </p>
          </div>
        </div>

        {recommendation.blockers.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
              What has to change first
            </p>
            <ul className="flex flex-col gap-1.5">
              {recommendation.blockers.map((b) => (
                <li key={b} className="text-sm leading-relaxed text-foreground text-pretty">
                  {b}
                </li>
              ))}
            </ul>
          </div>
        )}

        {recommendation.reasons.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Why
            </p>
            <ul className="flex flex-col gap-1.5">
              {recommendation.reasons.map((r) => (
                <li
                  key={r}
                  className="flex gap-2 text-sm leading-relaxed text-muted-foreground text-pretty"
                >
                  <span aria-hidden="true">-</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
