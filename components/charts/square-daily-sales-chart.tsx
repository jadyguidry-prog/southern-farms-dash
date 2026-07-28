'use client'

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

const config = {
  netSales: { label: 'Net sales', color: 'var(--chart-1)' },
} satisfies ChartConfig

/** Short axis label: "Mar 4" rather than the raw ISO date. */
function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  // Construct in UTC so the label cannot shift a day by local timezone.
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function SquareDailySalesChart({
  data,
  height = 260,
}: {
  data: { saleDate: string; netSales: number }[]
  height?: number
}) {
  const rows = data.map((d) => ({ ...d, label: shortDate(d.saleDate) }))

  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <AreaChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="fillSquareNet" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-netSales)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-netSales)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v) =>
            Math.abs(Number(v)) >= 1000
              ? `$${(Number(v) / 1000).toFixed(1)}K`
              : `$${Number(v).toFixed(0)}`
          }
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => `$${Number(value).toLocaleString()}`}
            />
          }
        />
        <Area
          dataKey="netSales"
          type="monotone"
          stroke="var(--color-netSales)"
          strokeWidth={2}
          fill="url(#fillSquareNet)"
        />
      </AreaChart>
    </ChartContainer>
  )
}
