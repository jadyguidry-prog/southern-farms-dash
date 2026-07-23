'use client'

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { salesTrend } from '@/lib/data'

const config = {
  wholesale: { label: 'Wholesale', color: 'var(--chart-1)' },
  retail: { label: 'Retail', color: 'var(--chart-3)' },
} satisfies ChartConfig

export function SalesTrendChart({ height = 300 }: { height?: number }) {
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <AreaChart data={salesTrend} margin={{ left: 4, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="fillWholesale" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-wholesale)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-wholesale)" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="fillRetail" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-retail)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-retail)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent formatter={(value) => `$${Number(value).toLocaleString()}`} />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Area
          dataKey="wholesale"
          type="monotone"
          stackId="a"
          stroke="var(--color-wholesale)"
          strokeWidth={2}
          fill="url(#fillWholesale)"
        />
        <Area
          dataKey="retail"
          type="monotone"
          stackId="a"
          stroke="var(--color-retail)"
          strokeWidth={2}
          fill="url(#fillRetail)"
        />
      </AreaChart>
    </ChartContainer>
  )
}
