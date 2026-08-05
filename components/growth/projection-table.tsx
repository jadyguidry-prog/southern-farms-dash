import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency } from '@/lib/data'
import type { ProjectedMonth } from '@/lib/growth-planner'

/** `2026-09` -> `Sep 2026`. Built from parts to avoid timezone drift. */
function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  if (!y || !m) return key
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * The month-by-month workings behind the verdict, so the number can be checked
 * rather than taken on faith.
 *
 * `relative` on the scroll container is required: the `sr-only` caption is
 * absolutely positioned, and without a positioned ancestor it anchors to the page
 * and silently stretches the document on a phone.
 */
export function ProjectionTable({
  baseline,
  reserveFloor,
  lowestMonthKey,
}: {
  baseline: ProjectedMonth[]
  reserveFloor: number
  lowestMonthKey: string
}) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="p-6 pb-0">
        <CardTitle className="text-base">The months behind the answer</CardTitle>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground text-pretty">
          Your projected cash with no new commitment. The low point is what the limits
          are tested against, not the ending balance.
        </p>
      </CardHeader>
      <CardContent className="p-6">
        {/* Month + closing cash only. This card sits in a narrow side column, and with
            In/Out columns the table needed a 30rem min-width and horizontal scroll --
            which pushed "Closing cash" off-screen. That is the one number every gate is
            actually tested against, so it must never be the column that gets clipped.
            No min-width and no overflow here means nothing can hide. */}
        <div className="relative">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Projected closing cash by month with no new commitment, compared against
              the reserve floor.
            </caption>
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="pb-2 pr-4 font-medium text-muted-foreground">
                  Month
                </th>
                <th scope="col" className="pb-2 text-right font-medium text-muted-foreground">
                  Closing cash
                </th>
              </tr>
            </thead>
            <tbody>
              {baseline.map((m) => {
                const belowFloor = m.closingCash < reserveFloor
                const isLow = m.monthKey === lowestMonthKey
                return (
                  <tr key={m.monthKey} className="border-b border-border last:border-0">
                    <th
                      scope="row"
                      className="py-2.5 pr-4 text-left font-normal text-foreground"
                    >
                      {monthLabel(m.monthKey)}
                      {isLow && (
                        <span className="ml-2 text-xs text-muted-foreground">low point</span>
                      )}
                    </th>
                    <td
                      className={`py-2.5 text-right font-mono font-semibold ${
                        belowFloor ? 'text-destructive' : 'text-foreground'
                      }`}
                    >
                      {formatCurrency(m.closingCash)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground text-pretty">
          Red means the month closes below your {formatCurrency(reserveFloor)} reserve
          floor.
        </p>
      </CardContent>
    </Card>
  )
}
