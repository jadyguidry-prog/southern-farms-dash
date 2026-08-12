import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { formatCurrency } from '@/lib/data'
import { cn } from '@/lib/utils'
import type { RiskMode } from '@/lib/growth-planner'

/**
 * Risk mode picker.
 *
 * Plain links rather than client state: changing mode re-runs the whole projection
 * on the server, so the URL is the single source of truth and a shared link shows
 * the same answer. Every threshold displayed here is read from the database, so
 * what the owner sees is genuinely what the math used.
 */
export function RiskModeSelector({
  modes,
  activeModeKey,
  minCashReserve,
}: {
  modes: RiskMode[]
  activeModeKey: string
  minCashReserve: number
}) {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-4 p-6">
        <div>
          <p className="text-sm font-medium text-foreground">How cautious should this be?</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground text-pretty">
            These are your limits, not ours. Every threshold below is stored as a
            setting you can change.
          </p>
        </div>

        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          role="group"
          aria-label="Risk mode"
        >
          {modes.map((m) => {
            const active = m.modeKey === activeModeKey
            return (
              <Link
                key={m.modeKey}
                href={`/growth?mode=${encodeURIComponent(m.modeKey)}`}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'flex flex-col gap-2 rounded-lg border p-4 transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-foreground bg-muted/50'
                    : 'border-border hover:border-foreground/40',
                )}
              >
                <span className="text-sm font-semibold text-foreground">{m.label}</span>
                <span className="text-xs leading-relaxed text-muted-foreground text-pretty">
                  {m.description}
                </span>
                <span className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                  <span>
                    Keeps{' '}
                    {m.reserveFloorPct >= 100
                      ? `all ${formatCurrency(minCashReserve)}`
                      : `${formatCurrency((minCashReserve * m.reserveFloorPct) / 100)} of ${formatCurrency(minCashReserve)}`}{' '}
                    in reserve
                  </span>
                  <span>{m.minDaysCash} days of cash minimum</span>
                  <span>
                    {m.locAllowed
                      ? `Will draw the credit line up to ${m.maxLocUtilizationPct}%`
                      : 'Will not draw the credit line'}
                  </span>
                </span>
              </Link>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
