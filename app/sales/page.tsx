import { TrendingUp, CalendarDays, ShoppingCart, Percent } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { SalesTrendChart } from '@/components/charts/sales-trend-chart'
import { SalesByProductChart } from '@/components/charts/sales-by-product-chart'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { kpis, salesByProduct, formatCurrency, formatPercent } from '@/lib/data'

export default function SalesPage() {
  const totalProductRev = salesByProduct.reduce((s, p) => s + p.revenue, 0)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Sales"
        description="Revenue performance across wholesale and retail channels and top-selling product lines."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Weekly Sales"
          value={formatCurrency(kpis.weeklySales.value)}
          icon={TrendingUp}
          change={kpis.weeklySales.change}
          trend={kpis.weeklySales.trend}
          changeLabel="vs prior week"
        />
        <StatCard
          label="Monthly Sales"
          value={formatCurrency(kpis.monthlySales.value)}
          icon={CalendarDays}
          change={kpis.monthlySales.change}
          trend={kpis.monthlySales.trend}
          changeLabel="vs prior month"
        />
        <StatCard
          label="Top Product Revenue"
          value={formatCurrency(salesByProduct[0].revenue)}
          icon={ShoppingCart}
          hint={salesByProduct[0].product}
        />
        <StatCard
          label="Gross Profit %"
          value={formatPercent(kpis.grossProfitPct.value)}
          icon={Percent}
          change={3.6}
          trend="up"
          changeLabel="above target"
        />
      </div>

      <div className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Revenue by Channel</CardTitle>
            <CardDescription>Wholesale vs retail · trailing 12 months</CardDescription>
          </CardHeader>
          <CardContent>
            <SalesTrendChart height={320} />
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Revenue by Product Line</CardTitle>
            <CardDescription>Trailing 90 days</CardDescription>
          </CardHeader>
          <CardContent>
            <SalesByProductChart />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Product Mix</CardTitle>
            <CardDescription>Share of product revenue</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {salesByProduct.map((p) => {
              const pct = (p.revenue / totalProductRev) * 100
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
