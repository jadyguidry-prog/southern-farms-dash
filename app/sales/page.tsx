import { TrendingUp, CalendarDays, ShoppingCart, Store } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { SalesTrendChart } from '@/components/charts/sales-trend-chart'
import { SalesByProductChart } from '@/components/charts/sales-by-product-chart'
import { MonthlySalesManager } from '@/components/sales/monthly-sales-manager'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { SquareSalesSection } from '@/components/sales/square-sales-section'
import { SalesSourceReview } from '@/components/sales/sales-source-review'
import { getSalesSourceAudit } from '@/lib/sales-source-audit-service'
import { formatCurrency } from '@/lib/data'
import { getSalesByProduct } from '@/lib/queries'
import { getMonthlySalesDetail, previewCalculatedSales } from '@/lib/sales-service'
import {
  getSquareDailySales,
  summarizeDailyRows,
  getSquareCategoryBreakdown,
} from '@/lib/square-sales-service'
import { getSquareConfigState } from '@/lib/square-client'

export default async function SalesPage() {
  const squareConfig = getSquareConfigState()
  const [
    monthly,
    salesByProduct,
    preview,
    squareDaily,
    squareCategories,
    sourceAudit,
  ] = await Promise.all([
    getMonthlySalesDetail(),
    getSalesByProduct(),
    previewCalculatedSales(),
    getSquareDailySales(),
    getSquareCategoryBreakdown(),
    getSalesSourceAudit(),
  ])

  const squareSummary = summarizeDailyRows(
    squareDaily.rows,
    squareDaily.conflictDays,
  )

  // Derive the headline figures from the stored months themselves. The old
  // `weeklySales`/`grossProfitPct` KPI rows were never populated, so those cards
  // rendered $0 and 0% — a confident-looking number with nothing behind it.
  const salesTrend = monthly.map((m) => ({
    month: m.month,
    wholesale: m.wholesale,
    retail: m.retail,
  }))

  const latest = monthly[monthly.length - 1]
  const prior = monthly[monthly.length - 2]
  const monthChange =
    latest && prior && prior.total > 0
      ? ((latest.total - prior.total) / prior.total) * 100
      : null

  const totalSales = monthly.reduce((s, m) => s + m.total, 0)
  const totalRetail = monthly.reduce((s, m) => s + m.retail, 0)
  const retailShare = totalSales > 0 ? (totalRetail / totalSales) * 100 : 0

  const totalProductRev = salesByProduct.reduce((s, p) => s + p.revenue, 0)
  const topProduct = salesByProduct[0]

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Sales"
        description="Revenue performance across wholesale and retail channels and top-selling product lines."
      />

      {/* Placed above the KPI cards on purpose: it explains why the revenue
          figures below it may be wrong, and that warning is useless after the
          owner has already read and trusted them. */}
      {sourceAudit.downgrades.length > 0 && (
        <div className="mb-4">
          <SalesSourceReview audit={sourceAudit} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={latest ? `${latest.month} ${latest.year} Sales` : 'Latest Month'}
          value={latest ? formatCurrency(latest.total) : '—'}
          icon={CalendarDays}
          change={monthChange ?? undefined}
          trend={
            monthChange == null ? undefined : monthChange >= 0 ? 'up' : 'down'
          }
          changeLabel="vs prior month"
          hint={latest ? undefined : 'No months calculated yet'}
        />
        <StatCard
          label="Total Sales Tracked"
          value={formatCurrency(totalSales)}
          icon={TrendingUp}
          hint={`${monthly.length} month${monthly.length === 1 ? '' : 's'} from bank records`}
        />
        <StatCard
          label="Retail Share"
          value={totalSales > 0 ? `${retailShare.toFixed(1)}%` : '—'}
          icon={Store}
          hint={
            totalSales > 0
              ? `${formatCurrency(totalRetail)} of ${formatCurrency(totalSales)}`
              : 'No sales data yet'
          }
        />
        <StatCard
          label="Top Product Revenue"
          value={topProduct ? formatCurrency(topProduct.revenue) : '—'}
          icon={ShoppingCart}
          hint={topProduct?.product ?? 'Add product revenue in Admin'}
        />
      </div>

      <div className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Revenue by Channel</CardTitle>
            <CardDescription>
              Wholesale vs retail ·{' '}
              {monthly.length > 0
                ? `${monthly.length} month${monthly.length === 1 ? '' : 's'} of imported records`
                : 'no data yet'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SalesTrendChart data={salesTrend} height={320} />
          </CardContent>
        </Card>
      </div>

      <div className="mt-4">
        <SquareSalesSection
          summary={squareSummary}
          daily={squareDaily.rows}
          categories={squareCategories}
          configured={squareConfig.configured}
        />
      </div>

      <div className="mt-4">
        <MonthlySalesManager
          rows={monthly}
          unclassified={preview.unclassified}
          excludedTotal={preview.excludedTotal}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Revenue by Product Line</CardTitle>
            <CardDescription>Trailing 90 days</CardDescription>
          </CardHeader>
          <CardContent>
            <SalesByProductChart data={salesByProduct} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Product Mix</CardTitle>
            <CardDescription>Share of product revenue</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {salesByProduct.map((p) => {
              const pct = totalProductRev ? (p.revenue / totalProductRev) * 100 : 0
              return (
                <div key={p.product}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium text-foreground">{p.product}</span>
                    <span className="font-mono text-muted-foreground">{pct.toFixed(1)}%</span>
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
      </div>
    </div>
  )
}
