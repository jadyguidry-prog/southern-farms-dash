import { formatCurrency } from '@/lib/data'
import type { LaborSummary, LaborMonth } from '@/lib/labor-service'

/**
 * Reporting view of the Square-timecard labor cost (rule 18's third consumer,
 * alongside the Dashboard payroll pillar and the AI Advisor).
 *
 * A plain table for the same reason as the cash flow report: this is the
 * surface used to reconcile against Square's own payroll export, so exact
 * figures matter more than shape.
 *
 * Two things are deliberately never smoothed over:
 *   - Months whose sales feed is incomplete show labor cost but NO percentage.
 *     A full month of wages divided by three days of sales is a meaningless
 *     number that looks like a crisis.
 *   - Hours with no wage on file are called out, because they make every
 *     total here a floor rather than the real cost.
 */
export function LaborReport({
  summary,
  monthly,
}: {
  summary: LaborSummary
  monthly: LaborMonth[]
}) {
  if (summary.shiftCount === 0) {
    return (
      <section
        aria-labelledby="labor-report"
        className="rounded-lg border border-border p-4"
      >
        <h2 id="labor-report" className="text-sm font-medium">
          Labor cost summary
        </h2>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">
          No Square timecards have been synced yet, so there is nothing to
          report. Run a Square sync to build this summary.
        </p>
      </section>
    )
  }

  // Newest first: reconciling almost always starts from the latest pay period.
  const rows = [...monthly].reverse()

  return (
    <section
      aria-labelledby="labor-report"
      className="rounded-lg border border-border p-4"
    >
      <h2 id="labor-report" className="text-sm font-medium">
        Labor cost summary
      </h2>
      <p className="mt-1 text-xs text-muted-foreground text-pretty">
        {summary.shiftCount.toLocaleString()} timecards across{' '}
        {summary.activeEmployees} people
        {summary.firstDate ? ` · ${summary.firstDate} to ${summary.lastDate}` : ''}
        . Unpaid breaks are deducted, so these are payable hours rather than
        time on the clock.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <caption className="sr-only">
            Monthly payable hours, estimated labor cost, net sales, and labor as
            a percentage of sales
          </caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="py-2 pr-3 font-medium">
                Month
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Payable hrs
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Labor cost
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Net sales
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Labor %
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.monthKey} className="border-b border-border/60">
                {/* `text-left` is explicit: a bare <th> centres by default,
                    which would misalign the month under its own header. */}
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {m.month}
                  {m.coverage === 'partial' && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      (partial sales)
                    </span>
                  )}
                  {m.coverage === 'none' && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      (no sales feed)
                    </span>
                  )}
                </th>
                <td className="py-2 pr-3 text-right font-mono text-xs">
                  {m.payableHours.toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs">
                  {formatCurrency(m.estimatedGrossLabor)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs">
                  {m.netSales == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    formatCurrency(m.netSales)
                  )}
                </td>
                <td className="py-2 text-right font-mono text-xs">
                  {m.laborPct == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    `${m.laborPct.toFixed(1)}%`
                  )}
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
                {summary.payableHours.toLocaleString(undefined, {
                  maximumFractionDigits: 1,
                })}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-xs">
                {formatCurrency(summary.estimatedGrossLabor)}
              </td>
              {/*
               * No total for sales or labor % on purpose. Summing sales across
               * months with incomplete coverage would produce a ratio that
               * disagrees with every row above it.
               */}
              <td className="py-2 pr-3 text-right text-xs text-muted-foreground">
                —
              </td>
              <td className="py-2 text-right text-xs text-muted-foreground">
                —
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {(summary.partialMonths.length > 0 ||
        summary.monthsWithoutSales.length > 0) && (
        <p className="mt-2 text-xs text-muted-foreground text-pretty">
          Months without a full sales feed show labor cost but no percentage,
          since a partial month of sales would invent an alarming ratio:{' '}
          {[...summary.monthsWithoutSales, ...summary.partialMonths].join(', ')}.
        </p>
      )}

      {summary.unpricedHours > 0 && (
        <>
          <h3 className="mt-5 text-sm font-medium">Hours with no wage on file</h3>
          <p className="mt-1 text-xs text-muted-foreground text-pretty">
            {Math.round(summary.unpricedHours).toLocaleString()} payable hours
            across {summary.unpricedShifts} shifts are costed at $0 because
            Square has no hourly rate for them. Every figure above is therefore a
            floor, not the real cost.
          </p>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[28rem] border-collapse text-sm">
              <caption className="sr-only">
                Uncosted hours grouped by person and job title
              </caption>
              <thead>
                <tr className="border-b border-border text-left">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Person
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Shifts
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Hours
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.unpricedBy.map((u) => (
                  <tr key={u.label} className="border-b border-border/60">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {u.label}
                    </th>
                    <td className="py-2 pr-3 text-right font-mono text-xs">
                      {u.shifts.toLocaleString()}
                    </td>
                    <td className="py-2 text-right font-mono text-xs">
                      {u.hours.toLocaleString(undefined, {
                        maximumFractionDigits: 1,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {summary.overtimeHours > 0 && (
        <p className="mt-4 text-xs text-muted-foreground text-pretty">
          Overtime: {summary.overtimeHours.toLocaleString(undefined, {
            maximumFractionDigits: 1,
          })}{' '}
          hours past 40 in a week, carrying an estimated{' '}
          {formatCurrency(summary.estimatedOvertimeCost)} in half-time premium
          across {summary.overtimeWeeks} weeks. The premium is the extra half,
          not the whole hour, since base pay is already counted in labor cost
          above.
        </p>
      )}
    </section>
  )
}
