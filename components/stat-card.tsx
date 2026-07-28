import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'

type Trend = 'up' | 'down'

export function StatCard({
  label,
  value,
  icon: Icon,
  change,
  trend,
  changeLabel,
  hint,
  goodDirection = 'up',
}: {
  label: string
  value: string
  icon: LucideIcon
  change?: number
  trend?: Trend
  changeLabel?: string
  hint?: string
  // Which direction is "good" (green). Defaults to up.
  goodDirection?: Trend
}) {
  const showChange = typeof change === 'number' && trend
  const isPositive = trend === goodDirection

  return (
    <Card className="gap-0 py-0">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
            <p className="mt-2 font-mono text-2xl font-bold tracking-tight text-foreground">
              {value}
            </p>
          </div>
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
            <Icon className="size-5" aria-hidden="true" />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          {showChange && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-semibold',
                isPositive
                  ? 'bg-primary/10 text-primary'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              {trend === 'up' ? (
                <ArrowUpRight className="size-3" aria-hidden="true" />
              ) : (
                <ArrowDownRight className="size-3" aria-hidden="true" />
              )}
              {/* Round here rather than trusting callers: an unrounded ratio
                  renders as "13.564812408387292%" and breaks the layout. */}
              {Math.abs(change!).toFixed(1)}%
            </span>
          )}
          {(changeLabel || hint) && (
            <span className="truncate text-xs text-muted-foreground">
              {changeLabel ?? hint}
            </span>
          )}
        </div>
        {/* Show the hint on its own line when a change label already took the slot above. */}
        {changeLabel && hint && (
          <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>
        )}
      </CardContent>
    </Card>
  )
}
