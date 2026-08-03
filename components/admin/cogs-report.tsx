// Monthly cost-of-goods and gross-profit reporting.
//
// Every row carries its own caveat rather than relying on a single footnote: a
// month with unattributed checks shows no margin at all, because a margin that
// silently excludes supplier spend is worse than no margin.

import type { CheckResolutionSnapshot } from '@/lib/check-resolution-service'
import { formatCurrency, formatPercent } from '@/lib/data'

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return month
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function CogsReport({ snapshot }: { snapshot: CheckResolutionSnapshot }) {
  if (!snapshot.hasChecks && snapshot.monthlyCogs.length === 0) return null

  const { readiness, progress, monthlyCogs } = snapshot

  // Only months with complete sales can carry a margin. A partial month
  // understates sales and would inflate the percentage.
  const rows = monthlyCogs.filter((m) => m.netSales > 0 || m.totalCogs > 0)
  const totals = rows.reduce(
    (acc, m) => ({
      netSales: acc.netSales + (m.salesComplete ? m.netSales : 0),
      totalCogs: acc.totalCogs + (m.salesComplete ? m.totalCogs : 0),
      unresolved: acc.unresolved + m.unresolvedCheckAmount,
    }),
    { netSales: 0, totalCogs: 0, unresolved: 0 },
  )

  return (
    <section
      aria-labelledby="cogs-report"
      className="rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="cogs-report" className="text-sm font-medium">
          Cost of Goods &amp; Gross Profit
        </h2>
        <p className="text-xs text-muted-foreground">
          {progress.resolvedCount.toLocaleString()} of{' '}
          {progress.totalChecks.toLocaleString()} checks attributed (
          {formatPercent(progress.resolvedPctOfAmount, 0)} of check dollars)
        </p>
      </div>

      {/*
        The readiness verdict leads, because it governs how every row below
        should be read. Stating it once at the top is clearer than repeating a
        hedge on each line.
      */}
      <p
        className={`mt-2 text-pretty text-xs ${
          readiness.ready ? 'text-muted-foreground' : 'text-destructive'
        }`}
      >
        {readiness.reason}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[38rem] border-collapse text-sm">
          <caption className="sr-only">
            Monthly net sales, cost of goods, gross profit and unattributed check
            amounts
          </caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="py-2 pr-3 font-medium">
                Month
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Net sales
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                COGS
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Gross profit
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Margin
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Unattributed
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              // A margin is shown only when sales are complete AND no checks are
              // outstanding for that month. Either gap makes the figure wrong in
              // a direction that flatters the business.
              const quotable =
                m.salesComplete && m.netSales > 0 && m.unresolvedCheckAmount <= 0
              const gp = m.netSales - m.totalCogs
              return (
                <tr key={m.month} className="border-b border-border/60">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {monthLabel(m.month)}
                    {!m.salesComplete && m.netSales > 0 ? (
                      <span className="ml-1 text-xs text-muted-foreground">
                        (partial)
                      </span>
                    ) : null}
                  </th>
                  <td className="py-2 pr-3 text-right font-mono text-xs">
                    {m.netSales > 0 ? formatCurrency(m.netSales) : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs">
                    {m.totalCogs > 0 ? formatCurrency(m.totalCogs) : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs">
                    {quotable && m.totalCogs > 0 ? formatCurrency(gp) : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs">
                    {quotable && m.totalCogs > 0
                      ? formatPercent((gp / m.netSales) * 100)
                      : '—'}
                  </td>
                  {/*
                    `relative` on the span below is load-bearing, not decoration.
                    Tailwind's `sr-only` is position:absolute, so without a
                    positioned ancestor it resolves against the page and lands past
                    the right edge of this horizontally scrolling table — which
                    stretched the document to 641px on a 390px phone and made the
                    whole admin page slide sideways. Anchoring it to the cell keeps
                    the screen-reader text without the overflow.
                  */}
                  <td className="py-2 text-right font-mono text-xs">
                    {m.unresolvedCheckAmount > 0 ? (
                      <span className="relative text-destructive">
                        {formatCurrency(m.unresolvedCheckAmount)}
                        <span className="sr-only">
                          {' '}
                          across {m.unresolvedCheckCount} unattributed checks
                        </span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <th scope="row" className="py-2 pr-3 text-left">
                Complete months
              </th>
              <td className="py-2 pr-3 text-right font-mono text-xs">
                {formatCurrency(totals.netSales)}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-xs">
                {formatCurrency(totals.totalCogs)}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-xs">
                {readiness.ready
                  ? formatCurrency(totals.netSales - totals.totalCogs)
                  : '—'}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-xs">
                {readiness.ready && totals.netSales > 0
                  ? formatPercent(
                      ((totals.netSales - totals.totalCogs) / totals.netSales) * 100,
                    )
                  : '—'}
              </td>
              <td className="py-2 text-right font-mono text-xs">
                {totals.unresolved > 0 ? formatCurrency(totals.unresolved) : '—'}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {snapshot.monthsMissingCogs.length > 0 ? (
        <p className="mt-3 text-pretty text-xs text-muted-foreground">
          {snapshot.monthsMissingCogs.length} complete{' '}
          {snapshot.monthsMissingCogs.length === 1 ? 'month has' : 'months have'}{' '}
          sales but no cost of goods recorded (
          {snapshot.monthsMissingCogs.map(monthLabel).join(', ')}). Stock was
          plainly bought, so this is a categorization gap rather than a month
          without purchases — any margin there would read as near-pure profit.
        </p>
      ) : null}
    </section>
  )
}
