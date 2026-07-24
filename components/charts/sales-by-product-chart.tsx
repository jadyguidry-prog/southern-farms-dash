'use client'

import { Bar, BarChart, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

const config = {
  revenue: { label: 'Revenue', color: 'var(--chart-1)' },
} satisfies ChartConfig

export function SalesByProductChart({
  data,
}: {
  data: { product: string; revenue: number }[]
}) {
  return (
    <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
      <BarChart
        data={data}
        layout="vertical"
        margin={{ left: 8, right: 16 }}
      >
        <XAxis type="number" hide />
        <YAxis
          dataKey="product"
          type="category"
          tickLine={false}
          axisLine={false}
          width={110}
          tick={{ fontSize: 12 }}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent formatter={(value) => `$${Number(value).toLocaleString()}`} />
          }
        />
        <Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} barSize={22} />
      </BarChart>
    </ChartContainer>
  )
}
