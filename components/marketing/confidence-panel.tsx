import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Confidence } from '@/lib/marketing-affordability-service'

/**
 * How much the recommendation should be trusted, and precisely why not more.
 *
 * A number presented without its data quality invites the owner to act on a
 * figure built from half-categorized books. Listing the gaps turns the weakness
 * into a to-do list instead of a hidden error.
 */
export function ConfidencePanel({ confidence }: { confidence: Confidence }) {
  const pillars = [
    confidence.recommendation,
    confidence.revenue,
    confidence.expense,
    confidence.cashFlow,
  ]

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="p-6 pb-0">
        <CardTitle>How much to trust this</CardTitle>
        <CardDescription className="text-pretty">
          Confidence tracks the completeness of the records underneath, not how confident the
          advice sounds.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 p-6">
        <div className="flex flex-col gap-4">
          {pillars.map((p) => (
            <div key={p.label} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium text-foreground">{p.label}</p>
                <p className="shrink-0 font-mono text-sm font-semibold text-foreground">{p.pct}%</p>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full',
                    p.pct >= 80 ? 'bg-emerald-600' : p.pct >= 50 ? 'bg-amber-500' : 'bg-destructive',
                  )}
                  style={{ width: `${p.pct}%` }}
                />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground text-pretty">{p.detail}</p>
            </div>
          ))}
        </div>

        {confidence.gaps.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <p className="text-sm font-semibold text-foreground">
              Fix these and the number gets sharper
            </p>
            <ul className="flex flex-col gap-1.5">
              {confidence.gaps.map((g) => (
                <li
                  key={g}
                  className="flex gap-2 text-sm leading-relaxed text-muted-foreground text-pretty"
                >
                  <span aria-hidden="true">-</span>
                  <span>{g}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
