'use client'

import { Line, LineChart, CartesianGrid, XAxis, YAxis, ReferenceLine } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

const config = {
  pct: { label: 'Payroll % of Sales', color: 'var(--chart-1)' },
} satisfies ChartConfig

export function PayrollChart({
  data: raw,
}: {
  data: { month: string; payroll: number; sales: number }[]
}) {
  const data = raw.map((d) => ({
    month: d.month,
    pct: d.sales ? Number(((d.payroll / d.sales) * 100).toFixed(1)) : 0,
  }))

  return (
    <ChartContainer config={config} className="aspect-auto h-[280px] w-full">
      <LineChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          domain={[0, 40]}
          tickFormatter={(v) => `${v}%`}
        />
        <ReferenceLine
          y={30}
          stroke="var(--chart-2)"
          strokeDasharray="4 4"
          label={{ value: 'Target 30%', position: 'insideTopRight', fill: 'var(--chart-2)', fontSize: 11 }}
        />
        <ChartTooltip content={<ChartTooltipContent formatter={(v) => `${v}%`} />} />
        <Line
          dataKey="pct"
          type="monotone"
          stroke="var(--color-pct)"
          strokeWidth={2.5}
          dot={{ r: 3, fill: 'var(--color-pct)' }}
        />
      </LineChart>
    </ChartContainer>
  )
}
