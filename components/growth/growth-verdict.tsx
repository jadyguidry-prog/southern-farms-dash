import { AlertTriangle, ShieldCheck, TrendingUp } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/data'
import type { RiskMode, RungEvaluation } from '@/lib/growth-planner'

/**
 * The answer first: the largest recurring and one-time commitment that survives
 * every gate, followed by the reserve and cushion that constrain it.
 *
 * $0 is a real, honest answer and is rendered as such rather than being softened.
 */
export function GrowthVerdict({
  maxRecurring,
  maxOneTime,
  edgeRecurring,
  edgeOneTime,
  mode,
  baseline,
  minCashReserve,
  horizonMonths,
  startMonthLabel,
}: {
  maxRecurring: number
  maxOneTime: number
  /** The unstressed ceiling, shown for context but never as the recommendation. */
  edgeRecurring: number
  edgeOneTime: number
  mode: RiskMode
  baseline: RungEvaluation
  minCashReserve: number
  horizonMonths: number
  startMonthLabel: string
}) {
  const declinePct = mode.headlineStressSalesDeclinePct
  // Only worth showing the ceiling when it is meaningfully above the recommendation;
  // otherwise it is noise.
  const showCeiling = edgeRecurring > maxRecurring * 1.05 && edgeRecurring > 0
  const nothingAffordable = maxRecurring <= 0 && maxOneTime <= 0

  // The baseline is "commit to nothing". If that already fails, no amount of
  // planning helps and the page must say so instead of showing a ladder of noes.
  const baselineFails = baseline.classification === 'Not Supported'

  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-6 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
              <TrendingUp className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                What you can take on from {startMonthLabel}
              </p>
            </div>

            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-8">
              <div>
                <p className="font-mono text-4xl font-bold tracking-tight text-foreground">
                  {formatCurrency(maxRecurring)}
                  <span className="ml-1 font-sans text-base font-medium text-muted-foreground">
                    /mo
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Ongoing monthly cost</p>
              </div>
              <div>
                <p className="font-mono text-2xl font-bold tracking-tight text-foreground">
                  {formatCurrency(maxOneTime)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">One-time purchase</p>
              </div>
            </div>

            {/* State the standard the headline was held to. Without this the number
                looks like a raw maximum, and the owner has no way to know it was
                chosen to survive a downturn rather than to sit at the limit. */}
            {maxRecurring > 0 || maxOneTime > 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
                Holds up even if sales fall {declinePct}% below your recent average.
                {showCeiling ? (
                  <>
                    {' '}
                    Your limits would technically stretch to{' '}
                    <span className="font-mono">{formatCurrency(edgeRecurring)}</span>/mo,
                    but that leaves nothing spare if sales dip.
                  </>
                ) : null}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            <Badge variant="outline" className="gap-1.5">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              {mode.label}
            </Badge>
            <p className="max-w-[16rem] text-xs leading-relaxed text-muted-foreground sm:text-right text-pretty">
              Judged over {horizonMonths} months, keeping{' '}
              {mode.reserveFloorPct >= 100
                ? `your full ${formatCurrency(minCashReserve)} reserve`
                : `${mode.reserveFloorPct}% of your ${formatCurrency(minCashReserve)} reserve`}{' '}
              and at least {mode.minDaysCash} days of cash.
            </p>
          </div>
        </div>

        {baselineFails ? (
          <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
              Committing to nothing new already breaks your limits
            </p>
            <p className="text-sm leading-relaxed text-foreground text-pretty">
              This is not about the investment — your projected cash falls below your
              limits over the next {horizonMonths} months even with no new spending at
              all. Fixing that comes first; the ladder below is shown for reference only.
            </p>
            <ul className="mt-1 flex flex-col gap-1.5">
              {baseline.failures.map((f) => (
                <li key={f} className="text-sm leading-relaxed text-foreground text-pretty">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        ) : nothingAffordable ? (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden="true" />
              {showCeiling
                ? 'Nothing new fits with room to spare'
                : 'No new commitment fits right now'}
            </p>
            {/* Two genuinely different situations. If the unstressed ceiling is above
                zero, something DOES fit on the expected path -- it just cannot absorb
                a downturn. Saying "nothing fits" there would be wrong and would hide
                a real option the owner may still want to weigh. */}
            {showCeiling ? (
              <p className="text-sm leading-relaxed text-foreground text-pretty">
                On your expected numbers your limits would stretch to{' '}
                <span className="font-mono">{formatCurrency(edgeRecurring)}</span>/mo — but
                none of that survives sales falling {declinePct}%, so none of it is
                recommended. The panels below show which limit binds first.
              </p>
            ) : (
              <p className="text-sm leading-relaxed text-foreground text-pretty">
                Your current position covers itself, but there is no room left for
                anything new without crossing a limit you set. The panels below show
                exactly which limit binds first and what would have to change.
              </p>
            )}
          </div>
        ) : null}

        <dl className="flex flex-col gap-4 border-t border-border pt-5 sm:flex-row sm:gap-8">
          <div className="min-w-0">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Lowest cash, no new spending
            </dt>
            <dd className="mt-1 font-mono text-lg font-semibold text-foreground">
              {formatCurrency(baseline.lowestProjectedCash)}
            </dd>
            <p className="mt-1 text-xs text-muted-foreground">
              Bottom of the {horizonMonths}-month projection
            </p>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Reserve floor
            </dt>
            <dd className="mt-1 font-mono text-lg font-semibold text-foreground">
              {formatCurrency(baseline.reserveFloor)}
            </dd>
            <p className="mt-1 text-xs text-muted-foreground">
              {mode.reserveFloorPct >= 100 ? 'Untouchable in this mode' : 'May be compressed'}
            </p>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Days of cash
            </dt>
            <dd className="mt-1 font-mono text-lg font-semibold text-foreground">
              {Number.isFinite(baseline.daysOfCash) ? Math.round(baseline.daysOfCash) : '—'}
              <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">
                / {mode.minDaysCash} min
              </span>
            </dd>
            <p className="mt-1 text-xs text-muted-foreground">At the projected low point</p>
          </div>
        </dl>
      </CardContent>
    </Card>
  )
}
