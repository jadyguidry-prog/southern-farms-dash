// Monthly cost-of-goods and gross-profit reporting.
//
// Every row carries its own caveat rather than relying on a single footnote: a
// month with unattributed checks shows no margin at all, because a margin that
// silently excludes supplier spend is worse than no margin.

import {
  marginWithheldLabel,
  type CheckResolutionSnapshot,
} from '@/lib/check-resolution-service'
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

  const rows = monthlyCogs.filter((m) => m.netSales > 0 || m.totalCogs > 0)
  // Only QUOTABLE months are aggregated. Summing on `salesComplete` alone once
  // folded in months whose bank data was never imported — full sales against a
  // fragment of the costs — which inflated the aggregate margin. A month that
  // cannot carry its own margin cannot contribute to a combined one either.
  const quotableRows = rows.filter((m) => m.quotable)
  const totals = quotableRows.reduce(
    (acc, m) => ({
      netSales: acc.netSales + m.netSales,
      totalCogs: acc.totalCogs + m.totalCogs,
    }),
    { netSales: 0, totalCogs: 0 },
  )
  // Unresolved dollars are counted across EVERY month, not just quotable ones:
  // the whole point is to show what is still outstanding.
  const unresolvedTotal = rows.reduce((s, m) => s + m.unresolvedCheckAmount, 0)

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

      {/*
        The table and the Dashboard headline apply DIFFERENT standards, so both
        say so. Per-month margins appear as soon as that one month is clean;
        the business-wide verdict above waits until unresolved checks are small
        across the whole record. Without this note the two just look contradictory.
      */}
      {!readiness.ready && quotableRows.length > 0 ? (
        <p className="mt-1 text-pretty text-xs text-muted-foreground">
          Individual months below are still shown once that month itself is clean
          — {quotableRows.length} of {rows.length}{' '}
          {rows.length === 1 ? 'month qualifies' : 'months qualify'}. The
          verdict above is about the whole record, which is why the Dashboard
          headline stays withheld while these rows carry figures.
        </p>
      ) : null}

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
              // Quotability is NOT recomputed here. It comes from the engine, so
              // this table and the Dashboard gauge cannot apply different rules —
              // they previously did, and the table showed margins the gauge would
              // have refused to draw.
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
                    {m.grossProfit != null ? formatCurrency(m.grossProfit) : '—'}
                  </td>
                  {/*
                    A withheld margin names its own reason inline rather than
                    showing a bare dash. The remedies differ per reason, so a
                    single footnote could not tell the owner what to actually do.
                  */}
                  <td className="py-2 pr-3 text-right text-xs">
                    {m.marginPct != null ? (
                      <span className="font-mono">
                        {formatPercent(m.marginPct)}
                      </span>
                    ) : m.withheldReason && m.netSales > 0 ? (
                      <span className="text-muted-foreground">
                        {marginWithheldLabel(m.withheldReason)}
                      </span>
                    ) : (
                      <span className="font-mono">—</span>
                    )}
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
              {/*
                Named for exactly what it sums — the months that can carry a
                margin — so a partial aggregate can never be mistaken for the
                whole record. The count is shown for the same reason.
              */}
              <th scope="row" className="py-2 pr-3 text-left">
                {quotableRows.length} measurable{' '}
                {quotableRows.length === 1 ? 'month' : 'months'}
                <span className="sr-only">
                  {' '}
                  of {rows.length} with activity
                </span>
              </th>
              <td className="py-2 pr-3 text-right font-mono text-xs">
                {totals.netSales > 0 ? formatCurrency(totals.netSales) : '—'}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-xs">
                {totals.totalCogs > 0 ? formatCurrency(totals.totalCogs) : '—'}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-xs">
                {quotableRows.length > 0
                  ? formatCurrency(totals.netSales - totals.totalCogs)
                  : '—'}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-xs">
                {quotableRows.length > 0 && totals.netSales > 0
                  ? formatPercent(
                      ((totals.netSales - totals.totalCogs) / totals.netSales) * 100,
                    )
                  : '—'}
              </td>
              <td className="py-2 text-right font-mono text-xs">
                {unresolvedTotal > 0 ? formatCurrency(unresolvedTotal) : '—'}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/*
        Two separate notes, because the REMEDY differs. Merging them once told the
        owner to categorize transactions in months that contain no transactions.
      */}
      {snapshot.monthsMissingBankData.length > 0 ? (
        <p className="mt-3 text-pretty text-xs text-muted-foreground">
          {snapshot.monthsMissingBankData.length}{' '}
          {snapshot.monthsMissingBankData.length === 1 ? 'month has' : 'months have'}{' '}
          sales but no bank transactions imported (
          {snapshot.monthsMissingBankData.map(monthLabel).join(', ')}). Only card
          statements reached these months, so the recorded cost of goods is a
          fragment of what was really spent and the margin would compute to
          almost pure profit. Importing the missing bank statements is what fixes
          this — there is nothing here to categorize yet.
        </p>
      ) : null}

      {snapshot.monthsMissingCogs.length > 0 ? (
        <p className="mt-3 text-pretty text-xs text-muted-foreground">
          {snapshot.monthsMissingCogs.length} complete{' '}
          {snapshot.monthsMissingCogs.length === 1 ? 'month has' : 'months have'}{' '}
          bank transactions and sales but nothing categorized as cost of goods (
          {snapshot.monthsMissingCogs.map(monthLabel).join(', ')}). Stock was
          plainly bought, so this is a categorization gap rather than a month
          without purchases — any margin there would read as near-pure profit.
        </p>
      ) : null}
    </section>
  )
}
