'use client'

import { Area, AreaChart, CartesianGrid, XAxis, YAxis, ReferenceLine } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { cashForecast } from '@/lib/data'

const config = {
  balance: { label: 'Projected Balance', color: 'var(--chart-1)' },
} satisfies ChartConfig

export function CashForecastChart() {
  return (
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
      <AreaChart data={cashForecast} margin={{ left: 4, right: 12, top: 8 }}>
        <defs>
          <linearGradient id="fillBalance" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-balance)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-balance)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`}
        />
        <ReferenceLine
          y={375000}
          stroke="var(--chart-2)"
          strokeDasharray="4 4"
          label={{
            value: 'Min buffer',
            position: 'insideTopRight',
            fill: 'var(--chart-2)',
            fontSize: 11,
          }}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => `$${Number(value).toLocaleString()}`}
            />
          }
        />
        <Area
          dataKey="balance"
          type="monotone"
          stroke="var(--color-balance)"
          strokeWidth={2}
          fill="url(#fillBalance)"
        />
      </AreaChart>
    </ChartContainer>
  )
}
