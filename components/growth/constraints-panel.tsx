import { CalendarClock, CreditCard, Info } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/data'
import type { CardSafetySummary } from '@/lib/card-safety'
import type { StrategicTiming } from '@/lib/growth-planner'

/**
 * Timing and card exposure.
 *
 * Timing is presented strictly as "when", never as "whether" — a seasonally weak
 * stretch makes an investment less attractive but not unaffordable, and merging the
 * two would either block safe spending or bless unsafe spending.
 */
export function ConstraintsPanel({
  strategy,
  cards,
  confidencePct,
  confidenceGaps,
}: {
  strategy: StrategicTiming
  cards: CardSafetySummary
  confidencePct: number
  confidenceGaps: string[]
}) {
  const ratingStyle =
    strategy.rating === 'Strong'
      ? 'border-transparent bg-emerald-600 text-white'
      : strategy.rating === 'Reasonable'
        ? 'border-transparent bg-amber-500 text-white'
        : 'border-transparent bg-muted text-foreground'

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="p-6 pb-0">
        <CardTitle className="text-base">Timing and card exposure</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 p-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <CalendarClock className="size-4 text-muted-foreground" aria-hidden="true" />
              Is now a good time?
            </p>
            <Badge className={ratingStyle}>{strategy.rating}</Badge>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
            {strategy.detail}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
            This affects whether it is a good moment, not whether you can afford it —
            those are judged separately on purpose.
          </p>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-5">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CreditCard className="size-4 text-muted-foreground" aria-hidden="true" />
            Credit cards
          </p>

          {!cards.hasCreditAccounts ? (
            <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
              No credit card accounts recorded yet. Card spending is a real channel, so
              until they are added this plan cannot see that exposure.
            </p>
          ) : (
            <>
              <dl className="flex flex-wrap gap-x-8 gap-y-3">
                {/* "Not tracked", never "$0". The only card row on file is the closed
                    Amex, so a literal $0 here is indistinguishable from a card that is
                    genuinely paid off -- and this business runs $11k-25k/month through
                    Amex. Showing $0 would understate real exposure to zero. */}
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Owed
                  </dt>
                  <dd className="mt-0.5 font-mono text-sm font-semibold text-foreground">
                    {cards.utilization === null && cards.totalOwed === 0
                      ? 'Not tracked'
                      : formatCurrency(cards.totalOwed)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Usable headroom
                  </dt>
                  <dd className="mt-0.5 font-mono text-sm font-semibold text-foreground">
                    {cards.utilization === null && cards.totalHeadroom === 0
                      ? 'Not tracked'
                      : formatCurrency(cards.totalHeadroom)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Utilisation
                  </dt>
                  <dd className="mt-0.5 font-mono text-sm font-semibold text-foreground">
                    {cards.utilization === null
                      ? 'Not known'
                      : `${Math.round(cards.utilization)}%`}
                  </dd>
                </div>
              </dl>

              {cards.warnings.length > 0 && (
                <ul className="mt-1 flex flex-col gap-1.5">
                  {cards.warnings.map((w) => (
                    <li
                      key={w}
                      className="flex gap-2 text-sm leading-relaxed text-muted-foreground text-pretty"
                    >
                      <span aria-hidden="true">-</span>
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-5">
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Info className="size-4 text-muted-foreground" aria-hidden="true" />
              How much to trust this
            </p>
            <span className="font-mono text-sm font-semibold text-foreground">
              {Math.round(confidencePct)}%
            </span>
          </div>
          {confidenceGaps.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {confidenceGaps.map((g) => (
                <li
                  key={g}
                  className="flex gap-2 text-sm leading-relaxed text-muted-foreground text-pretty"
                >
                  <span aria-hidden="true">-</span>
                  <span>{g}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
              Every figure this uses is present and current.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
