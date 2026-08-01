import Link from 'next/link'
import { ListChecks, ArrowRight } from 'lucide-react'
import { formatCurrency } from '@/lib/data'
import type { CashFlowInsight } from '@/lib/cash-flow-service'

/** "2026-07-01" -> "July 2026", for stating the window in plain language. */
function monthLabel(isoDate: string): string {
  const [year, month] = isoDate.split('-')
  const name = new Date(Number(year), Number(month) - 1, 1).toLocaleString('en-US', {
    month: 'long',
  })
  return `${name} ${year}`
}

/**
 * A quiet link over to Category Review, shown only when the already-loaded
 * cash-flow insight reveals cleanup that would change reported numbers:
 * uncategorized spend, mis-typed income, or an incomplete month. Derives
 * everything from the insight the page already has, so it adds no query.
 *
 * The headline counts only the present window (last month onward). Measured over
 * all history it was dominated by ~200 `CHECK ####` lines from 2025 that the
 * statement never attributed to anyone, so it reported a six-figure problem that
 * no amount of review could ever clear. Older gaps still appear, but as a muted
 * aside that cannot drown out this month's work.
 */
export function ReviewNudge({
  insight,
  className,
}: {
  insight: CashFlowInsight
  className?: string
}) {
  const mistyped = insight.present.spendByCategory.suspectedMistyped
  const mistypedAmount = mistyped.reduce((s, m) => s + m.amount, 0)
  const unidentified = insight.present.outflows.unidentified
  const incompleteMonths = insight.monthly.incompleteMonths.length
  const backlog = insight.historicalBacklog

  const reasons: string[] = []
  if (unidentified.count > 0) {
    reasons.push(
      `${formatCurrency(unidentified.amount)} across ${unidentified.count} payments has no identified payee`,
    )
  }
  if (mistyped.length > 0) {
    reasons.push(
      `${formatCurrency(mistypedAmount)} is filed as income but counted as spending`,
    )
  }
  if (incompleteMonths > 0) {
    reasons.push(
      `${incompleteMonths} month${incompleteMonths === 1 ? '' : 's'} ${incompleteMonths === 1 ? 'is' : 'are'} missing bank deposits`,
    )
  }

  const backlogNote =
    backlog.unidentifiedCount > 0
      ? `Older than ${monthLabel(insight.present.windowStart)}: ${formatCurrency(backlog.unidentifiedAmount)} across ${backlog.unidentifiedCount} payments the bank never named. Left as-is on purpose.`
      : null

  // Nothing recent to fix: stay silent rather than nag about closed history.
  if (reasons.length === 0) return null

  return (
    <Link
      href="/category-review"
      className={`group flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-4 transition-colors hover:bg-muted ${className ?? ''}`}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
        <ListChecks className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          {monthLabel(insight.present.windowStart)} onward can be sharpened
        </span>
        <span className="block text-sm text-muted-foreground text-pretty">
          {reasons.join(' · ')}. Review and fix categorization &mdash; every
          change needs your approval.
        </span>
        {backlogNote ? (
          <span className="mt-1 block text-xs text-muted-foreground/70 text-pretty">
            {backlogNote}
          </span>
        ) : null}
      </span>
      <ArrowRight
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  )
}
