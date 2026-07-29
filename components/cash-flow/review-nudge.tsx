import Link from 'next/link'
import { ListChecks, ArrowRight } from 'lucide-react'
import { formatCurrency } from '@/lib/data'
import type { CashFlowInsight } from '@/lib/cash-flow-service'

/**
 * A quiet link over to Category Review, shown only when the already-loaded
 * cash-flow insight reveals cleanup that would change reported numbers:
 * uncategorized spend, mis-typed income, or an incomplete month. Derives
 * everything from the insight the page already has, so it adds no query.
 */
export function ReviewNudge({
  insight,
  className,
}: {
  insight: CashFlowInsight
  className?: string
}) {
  const mistyped = insight.spendByCategory.suspectedMistyped
  const mistypedAmount = mistyped.reduce((s, m) => s + m.amount, 0)
  const unidentified = insight.outflows.unidentified
  const incompleteMonths = insight.monthly.incompleteMonths.length

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
          These numbers can be sharpened
        </span>
        <span className="block text-sm text-muted-foreground text-pretty">
          {reasons.join(' · ')}. Review and fix categorization &mdash; every
          change needs your approval.
        </span>
      </span>
      <ArrowRight
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  )
}
