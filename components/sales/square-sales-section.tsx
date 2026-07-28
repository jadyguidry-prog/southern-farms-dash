import Link from 'next/link'
import {
  CreditCard,
  Receipt,
  TriangleAlert,
  Percent,
  Plug,
} from 'lucide-react'
import { StatCard } from '@/components/stat-card'
import { SquareDailySalesChart } from '@/components/charts/square-daily-sales-chart'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { formatCurrency } from '@/lib/data'
import type {
  SquareDailyRow,
  SquareSalesSummary,
  SquareCategoryRow,
} from '@/lib/square-sales-service'

/**
 * Square point-of-sale performance.
 *
 * When there is no Square data this renders an explicit explanation of *why*
 * it is empty and what to do about it, rather than a grid of $0 cards that
 * look like real (terrible) sales figures.
 */
export function SquareSalesSection({
  summary,
  daily,
  categories,
  configured,
}: {
  summary: SquareSalesSummary
  daily: SquareDailyRow[]
  categories: SquareCategoryRow[]
  configured: boolean
}) {
  const hasData = summary.netSales !== null && summary.dayCount > 0

  if (!hasData) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Square Point of Sale</CardTitle>
          <CardDescription>
            Daily register sales, refunds and category mix from Square.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-6">
            <div className="flex size-10 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
              <Plug className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">
                No Square sales recorded yet
              </p>
              <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted-foreground">
                {configured
                  ? 'Square is connected, but no sales have been pulled in yet. Run a sync to load your register history.'
                  : 'Square is not connected yet. Add your Square access token to pull in register sales automatically, or import a CSV export from your Square dashboard.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/settings"
                className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                {configured ? 'Go to sync controls' : 'Connect Square'}
              </Link>
              <Link
                href="/admin"
                className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary"
              >
                Import a CSV
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  const netSales = summary.netSales ?? 0
  const feeRate = netSales > 0 ? (summary.processingFees / netSales) * 100 : null
  const topCategoryTotal = categories.reduce((s, c) => s + c.revenue, 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Square Net Sales"
          value={formatCurrency(netSales)}
          icon={CreditCard}
          hint={
            summary.firstDate && summary.lastDate
              ? `${summary.dayCount} day${summary.dayCount === 1 ? '' : 's'} · ${summary.firstDate} to ${summary.lastDate}`
              : undefined
          }
        />
        <StatCard
          label="Transactions"
          value={summary.transactionCount.toLocaleString()}
          icon={Receipt}
          hint={
            summary.averageTicket !== null
              ? `${formatCurrency(summary.averageTicket)} average ticket`
              : 'No transactions recorded'
          }
        />
        <StatCard
          label="Refunds"
          value={formatCurrency(summary.refunds)}
          icon={TriangleAlert}
          goodDirection="down"
          hint={`${formatCurrency(summary.discounts)} in discounts`}
        />
        <StatCard
          label="Processing Fees"
          value={formatCurrency(summary.processingFees)}
          icon={Percent}
          goodDirection="down"
          hint={
            feeRate !== null
              ? `${feeRate.toFixed(2)}% of net sales`
              : 'No fees recorded'
          }
        />
      </div>

      {summary.conflictDays.length > 0 && (
        <div
          role="status"
          className="rounded-lg border border-border bg-secondary/50 p-4"
        >
          <p className="text-sm font-medium text-foreground">
            {summary.conflictDays.length} day
            {summary.conflictDays.length === 1 ? '' : 's'} reported different
            totals from more than one source
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            The live Square sync and an imported CSV disagree on{' '}
            {summary.conflictDays.slice(0, 5).join(', ')}
            {summary.conflictDays.length > 5
              ? ` and ${summary.conflictDays.length - 5} more`
              : ''}
            . The figures above use the live sync, which takes priority. Each day
            is counted once, so totals are not inflated.
          </p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily Square Sales</CardTitle>
          <CardDescription>
            Net sales per day
            {summary.sourceMix.length > 0 && (
              <>
                {' · '}
                {summary.sourceMix
                  .map((s) => `${s.days} from ${s.label}`)
                  .join(', ')}
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SquareDailySalesChart
            data={daily.map((d) => ({
              saleDate: d.saleDate,
              netSales: d.netSales,
            }))}
          />
        </CardContent>
      </Card>

      {categories.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Square Category Mix</CardTitle>
            <CardDescription>
              Revenue by Square category · {formatCurrency(topCategoryTotal)} total
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {categories.map((c) => {
              const pct =
                topCategoryTotal > 0 ? (c.revenue / topCategoryTotal) * 100 : 0
              return (
                <div key={c.category}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium text-foreground">
                      {c.category}
                    </span>
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {formatCurrency(c.revenue)} · {pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
