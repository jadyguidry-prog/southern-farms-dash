import { formatCurrency } from '@/lib/data'
import { monthLabel, type CashFlowInsight } from '@/lib/cash-flow-service'

/**
 * Reporting view of the bank-derived cash flow (rule 18's third consumer).
 *
 * Deliberately a plain table rather than a chart: this is the surface used to
 * reconcile against statements, so exact figures matter more than shape. Every
 * number comes from imported transactions, and months missing their deposit
 * account are labelled rather than quietly shown as losses.
 */
export function CashFlowReport({ insight }: { insight: CashFlowInsight }) {
  const { monthly, spendByCategory, transactionCount, dateRange } = insight

  if (transactionCount === 0) {
    return (
      <section
        aria-labelledby="cash-flow-report"
        className="rounded-lg border border-border p-4"
      >
        <h2 id="cash-flow-report" className="text-sm font-medium">
          Cash flow summary
        </h2>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">
          No bank transactions have been imported yet, so there is nothing to
          report. Import statements from the Vendors page to build this summary.
        </p>
      </section>
    )
  }

  // Newest first: reconciling almost always starts from the latest statement.
  const rows = [...monthly.series].reverse()
  const totals = rows.reduce(
    (acc, m) => ({
      inflow: acc.inflow + m.inflow,
      outflow: acc.outflow + m.outflow,
    }),
    { inflow: 0, outflow: 0 },
  )
  const net = totals.inflow - totals.outflow

  return (
    <section
      aria-labelledby="cash-flow-report"
      className="rounded-lg border border-border p-4"
    >
      <h2 id="cash-flow-report" className="text-sm font-medium">
        Cash flow summary
      </h2>
      <p className="mt-1 text-xs text-muted-foreground text-pretty">
        {transactionCount.toLocaleString()} imported transactions
        {dateRange ? ` · ${dateRange.from} to ${dateRange.to}` : ''}. Transfers
        and card payments are excluded so paying a card is not counted twice as
        spending.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <caption className="sr-only">
            Monthly cash in, cash out, and net movement from imported bank
            transactions
          </caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="py-2 pr-3 font-medium">
                Month
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Cash in
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Cash out
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.monthKey} className="border-b border-border/60">
                <th scope="row" className="py-2 pr-3 font-normal">
                  {m.month}
                  {!m.complete && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      (card only)
                    </span>
                  )}
                </th>
                <td className="py-2 pr-3 text-right font-mono text-xs">
                  {formatCurrency(m.inflow)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs">
                  {formatCurrency(m.outflow)}
                </td>
                <td className="py-2 text-right font-mono text-xs">
                  {formatCurrency(m.net)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <th scope="row" className="py-2 pr-3 text-left">
                Total
              </th>
              <td className="py-2 pr-3 text-right font-mono text-xs">
                {formatCurrency(totals.inflow)}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-xs">
                {formatCurrency(totals.outflow)}
              </td>
              <td className="py-2 text-right font-mono text-xs">
                {formatCurrency(net)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {monthly.incompleteMonths.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground text-pretty">
          Months marked &ldquo;card only&rdquo; have no deposit account
          imported, so their
          cash in is understated:{' '}
          {monthly.incompleteMonths.map(monthLabel).join(', ')}.
        </p>
      )}

      <h3 className="mt-5 text-sm font-medium">Spending by category</h3>
      <p className="mt-1 text-xs text-muted-foreground text-pretty">
        {(spendByCategory.coverage * 100).toFixed(0)}% of{' '}
        {formatCurrency(spendByCategory.totalSpend)} in spending carries a
        category. The rest is shown as uncategorized rather than spread across
        buckets.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[28rem] border-collapse text-sm">
          <caption className="sr-only">
            Spending totals by category, including uncategorized spend
          </caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="py-2 pr-3 font-medium">
                Category
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Amount
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {spendByCategory.categories.map((c) => (
              <tr key={c.category} className="border-b border-border/60">
                <th scope="row" className="py-2 pr-3 font-normal">
                  {c.category}
                  {c.mergedFrom.length > 0 && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      (includes {c.mergedFrom.join(', ')})
                    </span>
                  )}
                </th>
                <td className="py-2 pr-3 text-right font-mono text-xs">
                  {formatCurrency(c.amount)}
                </td>
                <td className="py-2 text-right font-mono text-xs">
                  {(c.share * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
            {spendByCategory.uncategorizedSpend > 0 && (
              <tr className="border-b border-border/60 text-muted-foreground">
                <th scope="row" className="py-2 pr-3 font-normal">
                  Uncategorized
                </th>
                <td className="py-2 pr-3 text-right font-mono text-xs">
                  {formatCurrency(spendByCategory.uncategorizedSpend)}
                </td>
                <td className="py-2 text-right font-mono text-xs">
                  {spendByCategory.totalSpend > 0
                    ? (
                        (spendByCategory.uncategorizedSpend /
                          spendByCategory.totalSpend) *
                        100
                      ).toFixed(1)
                    : '0.0'}
                  %
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
