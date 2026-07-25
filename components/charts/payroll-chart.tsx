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
  target = 15,
  warning,
}: {
  data: { month: string; payroll: number; sales: number }[]
  target?: number
  warning?: number
}) {
  const data = raw.map((d) => ({
    month: d.month,
    pct: d.sales ? Number(((d.payroll / d.sales) * 100).toFixed(1)) : 0,
  }))

  // Keep the target line and every data point comfortably in view.
  const maxPct = Math.max(target, warning ?? 0, ...data.map((d) => d.pct))
  const axisMax = Math.ceil((maxPct + 5) / 5) * 5

  return (
    <ChartContainer config={config} className="aspect-auto h-[280px] w-full">
      <LineChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          domain={[0, axisMax]}
          tickFormatter={(v) => `${v}%`}
        />
        <ReferenceLine
          y={target}
          stroke="var(--chart-2)"
          strokeDasharray="4 4"
          label={{
            value: `Target ${target}%`,
            position: 'insideTopRight',
            fill: 'var(--chart-2)',
            fontSize: 11,
          }}
        />
        {typeof warning === 'number' && warning !== target && (
          <ReferenceLine
            y={warning}
            stroke="var(--destructive)"
            strokeDasharray="4 4"
            label={{
              value: `Warning ${warning}%`,
              position: 'insideBottomRight',
              fill: 'var(--destructive)',
              fontSize: 11,
            }}
          />
        )}
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
