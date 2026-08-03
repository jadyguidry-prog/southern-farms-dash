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
        <div className="relative -mx-6 overflow-x-auto px-6">
          <table className="w-full min-w-[30rem] border-collapse text-sm">
            <caption className="sr-only">
              Projected cash by month with no new commitment, showing inflow, outflow
              and closing balance against the reserve floor.
            </caption>
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="pb-2 pr-4 font-medium text-muted-foreground">
                  Month
                </th>
                <th scope="col" className="pb-2 pr-4 text-right font-medium text-muted-foreground">
                  In
                </th>
                <th scope="col" className="pb-2 pr-4 text-right font-medium text-muted-foreground">
                  Out
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
                    <td className="py-2.5 pr-4 text-right font-mono text-muted-foreground">
                      {formatCurrency(m.inflow)}
                    </td>
                    <td className="py-2.5 pr-4 text-right font-mono text-muted-foreground">
                      {formatCurrency(m.outflow)}
                    </td>
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
