import { AlertTriangle } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * Warns when the marketing affordability numbers are built on a lagging bank
 * feed. Every cash figure on this page is only as current as the last imported
 * transaction, so a stale feed has to be stated plainly — the "$229 / -$1,663"
 * confusion came partly from month-old data being read as today's position.
 *
 * Renders nothing when the feed is current, so it stays out of the way until it
 * actually matters.
 */
export function MarketingDataFreshness({
  latestTransactionDate,
  daysBehind,
  isStale,
  className,
}: {
  latestTransactionDate: string | null
  daysBehind: number | null
  isStale: boolean
  className?: string
}) {
  if (!isStale || daysBehind === null) return null

  const latestLabel = latestTransactionDate
    ? new Date(latestTransactionDate + 'T00:00:00').toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : 'an unknown date'

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-foreground text-pretty">
          These numbers are {daysBehind} days behind
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
          Your most recent bank transaction is from {latestLabel}. Every cash figure below is
          worked out from what has been imported so far, so a recommendation will look lower than
          reality until the rest of your statements are in. Import your latest bank activity to
          sharpen these numbers.
        </p>
      </div>
    </div>
  )
}
