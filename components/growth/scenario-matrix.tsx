import { ShieldAlert } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/data'
import type { Classification, Commitment, ScenarioResult } from '@/lib/growth-planner'

/**
 * "Does the recommendation survive a bad year?"
 *
 * The ladder answers what is affordable on the expected path. This answers whether
 * the SAME commitment still holds when sales fall or costs rise. Both are needed: a
 * number that is affordable only if nothing goes wrong is not really affordable.
 *
 * Deliberately stress-tests the headline recommendation rather than an arbitrary
 * amount, so this cannot report resilience for a figure the owner is not considering.
 */

const CLASS_STYLE: Record<Classification, { badge: string; label: string }> = {
  'Very Safe': { badge: 'border-transparent bg-emerald-600 text-white', label: 'Holds' },
  Comfortable: { badge: 'border-transparent bg-emerald-600 text-white', label: 'Holds' },
  Supported: { badge: 'border-transparent bg-emerald-700 text-white', label: 'Holds' },
  Tight: { badge: 'border-transparent bg-amber-500 text-white', label: 'Tight' },
  'Not Supported': { badge: 'border-transparent bg-destructive text-white', label: 'Breaks' },
}

/**
 * `Commitment` carries recurring and one-time amounts TOGETHER, not as a tagged
 * union, so both can be non-zero at once and the label has to say so. Describing
 * only one part would understate what was actually stress-tested.
 */
function commitmentLabel(c: Commitment): string {
  const parts: string[] = []
  if (c.recurringMonthly > 0) parts.push(`${formatCurrency(c.recurringMonthly)}/mo`)
  if (c.oneTime > 0) parts.push(`${formatCurrency(c.oneTime)} one-time`)
  return parts.length === 0 ? 'no new commitment' : parts.join(' plus ')
}

function isNoCommitment(c: Commitment): boolean {
  return c.recurringMonthly <= 0 && c.oneTime <= 0
}

export function ScenarioMatrix({
  scenarios,
  commitment,
  modeLabel,
}: {
  scenarios: ScenarioResult[]
  commitment: Commitment
  modeLabel: string
}) {
  if (scenarios.length === 0) return null

  const breaking = scenarios.filter((s) => s.classification === 'Not Supported')
  const isBaseline = isNoCommitment(commitment)

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="p-6 pb-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-4 text-muted-foreground" aria-hidden="true" />
          Would it survive a bad year?
        </CardTitle>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground text-pretty">
          {isBaseline ? (
            <>
              Your current position with no new commitment, put through each downturn.
              This is what a bad year does to you even if you take on nothing.
            </>
          ) : (
            <>
              Taking on <span className="font-medium text-foreground">
                {commitmentLabel(commitment)}
              </span>{' '}
              and then running each downturn against it. Affordable on the expected path
              is not the same as affordable if sales slip.
            </>
          )}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-6">
        <ul className="flex flex-col">
          {scenarios.map((s) => {
            const style = CLASS_STYLE[s.classification]
            // Only the binding constraint. Listing every downstream consequence
            // buries the one thing that would actually have to change.
            const reason = s.failures[0] ?? s.tradeoffs[0] ?? null
            return (
              <li
                key={s.key}
                className="flex flex-col gap-1.5 border-b border-border py-3 first:pt-0 last:border-0 last:pb-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">{s.label}</span>
                    <span className="text-xs leading-relaxed text-muted-foreground text-pretty">
                      {s.description}
                    </span>
                  </div>
                  <Badge className={`${style.badge} shrink-0`}>{style.label}</Badge>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                  <span>Low point</span>
                  <span className="font-mono font-semibold text-foreground">
                    {formatCurrency(s.lowestProjectedCash)}
                  </span>
                  <span>in {s.lowestMonthKey}</span>
                </div>
                {reason && (
                  <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
                    {reason}
                  </p>
                )}
              </li>
            )
          })}
        </ul>

        <p className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground text-pretty">
          {breaking.length === 0 ? (
            <>
              This holds in every downturn tested, judged against your {modeLabel} limits.
              That is a genuine cushion, not a forecast — the scenarios are multipliers on
              your own averages, so they are only as good as the history behind them.
            </>
          ) : (
            <>
              Breaks in {breaking.length} of {scenarios.length} scenarios:{' '}
              {breaking.map((b) => b.label).join(', ')}. That does not mean do not do it —
              it means know which way the wind has to blow before this hurts.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  )
}
