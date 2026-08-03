import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/data'
import type { Classification, LadderRung } from '@/lib/growth-planner'

/**
 * The ladder: at each amount, supported / supported-with-tradeoffs / not supported,
 * plus the single reason it fails. The reason is the point — a bare "no" teaches
 * nothing about what would have to change.
 */

// Keyed to `Classification` so adding a band is a compile error here rather than a
// silently unstyled badge at runtime.
const CLASS_STYLE: Record<Classification, { badge: string; label: string }> = {
  'Very Safe': {
    badge: 'border-transparent bg-emerald-600 text-white',
    label: 'Very safe',
  },
  Comfortable: {
    badge: 'border-transparent bg-emerald-600 text-white',
    label: 'Comfortable',
  },
  Supported: {
    badge: 'border-transparent bg-emerald-700 text-white',
    label: 'Supported',
  },
  Tight: {
    badge: 'border-transparent bg-amber-500 text-white',
    label: 'Tight',
  },
  'Not Supported': {
    badge: 'border-transparent bg-destructive text-white',
    label: 'Not supported',
  },
}

function RungRow({ rung }: { rung: LadderRung }) {
  const style = CLASS_STYLE[rung.classification]
  // Only the FIRST failure is shown: it is the binding constraint, and listing
  // every downstream consequence buries the one thing that actually has to change.
  const primary = rung.failures[0] ?? rung.tradeoffs[0] ?? null

  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="font-mono text-sm font-semibold text-foreground">
          {formatCurrency(rung.amount)}
          {rung.kind === 'recurring' && (
            <span className="ml-0.5 font-sans text-xs font-normal text-muted-foreground">
              /mo
            </span>
          )}
        </span>
        {rung.isCustom && (
          <Badge variant="outline" className="shrink-0 text-xs">
            Yours
          </Badge>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:items-end">
        <Badge className={`${style.badge} shrink-0`}>{style.label}</Badge>
        {primary && (
          <p className="text-xs leading-relaxed text-muted-foreground sm:text-right text-pretty">
            {primary}
          </p>
        )}
      </div>
    </li>
  )
}

export function CapacityLadder({ ladder }: { ladder: LadderRung[] }) {
  const recurring = ladder.filter((r) => r.kind === 'recurring')
  const oneTime = ladder.filter((r) => r.kind === 'one-time')

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="p-6 pb-0">
        <CardTitle className="text-base">What each amount would mean</CardTitle>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground text-pretty">
          Every rung is tested against your own limits. Where it fails, the reason is
          the constraint that binds first — that is the thing to change.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 p-6">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Ongoing monthly cost
          </p>
          <ul className="flex flex-col">
            {recurring.map((r) => (
              <RungRow key={`r-${r.amount}-${r.isCustom}`} rung={r} />
            ))}
          </ul>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            One-time purchase
          </p>
          <ul className="flex flex-col">
            {oneTime.map((r) => (
              <RungRow key={`o-${r.amount}-${r.isCustom}`} rung={r} />
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}
