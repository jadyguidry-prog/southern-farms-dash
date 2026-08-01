import Link from 'next/link'
import { CloudOff, ArrowRight } from 'lucide-react'

/**
 * Warns when the Square feed has fallen behind the calendar.
 *
 * This exists because of a real failure: the sync was manual-only and drifted
 * four days behind, so the dashboard reported July sales of $78,630 when Square
 * showed $96,112. Every figure was internally consistent and nothing errored --
 * the total was simply missing four days. A silently stale feed understates
 * revenue, so the gap has to be visible on the page rather than only discovered
 * by comparing against Square by hand.
 *
 * Renders nothing while the feed is current, so it stays quiet in normal use.
 */
export function SalesDataStaleness({
  throughDate,
  className,
  /** Days behind before this warns. One day of lag is normal and not worth nagging about. */
  warnAfterDays = 2,
}: {
  throughDate: string | null | undefined
  className?: string
  warnAfterDays?: number
}) {
  if (!throughDate) return null

  // Compare calendar days in UTC. Both sides are plain YYYY-MM-DD date strings,
  // so this avoids a local-timezone shift turning into a phantom day of lag.
  const through = new Date(`${throughDate}T00:00:00Z`)
  if (Number.isNaN(through.getTime())) return null

  const now = new Date()
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const daysBehind = Math.floor((today - through.getTime()) / 86_400_000)

  if (daysBehind < warnAfterDays) return null

  const throughLabel = through.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })

  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4 ${className ?? ''}`}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
        <CloudOff className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          Square sales are {daysBehind} days behind
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground text-pretty">
          The latest sales data is from {throughLabel}. Sales figures below are
          real but incomplete, so they understate the period until the sync
          catches up.
        </p>
        <Link
          href="/settings"
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline underline-offset-4 hover:no-underline"
        >
          Sync now in Settings
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  )
}
