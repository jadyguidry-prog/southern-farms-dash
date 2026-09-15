'use client'

import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart'

const config = {
  inflow: { label: 'Cash In', color: 'var(--chart-1)' },
  outflow: { label: 'Cash Out', color: 'var(--chart-2)' },
} satisfies ChartConfig

/**
 * All three flags are optional so existing callers keep working. A bar is faded
 * when the month cannot be read as a finished result:
 *
 * - `complete === false` — spending but no deposits, so only a card statement
 *   was imported and the month would otherwise read as a total loss.
 * - `partial` — the month is over but was imported only part-way through.
 * - `inProgress` — the current month, which is simply not finished yet.
 *
 * Fading only `complete === false` was not enough: Aug '26 held deposits for
 * its first 13 days, passed that test, and was drawn solid at $26,110.
 */
export function CashFlowChart({
  data,
}: {
  data: {
    month: string
    inflow: number
    outflow: number
    complete?: boolean
    partial?: boolean
    inProgress?: boolean
  }[]
}) {
  const isProvisional = (i: number) => {
    const d = data[i]
    if (!d) return false
    return d.complete === false || d.partial === true || d.inProgress === true
  }
  const fadeFor = (i: number) => (isProvisional(i) ? 0.35 : 1)
  return (
    <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
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
        <Bar dataKey="inflow" fill="var(--color-inflow)" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={`in-${d.month}`} fillOpacity={fadeFor(i)} />
          ))}
        </Bar>
        <Bar dataKey="outflow" fill="var(--color-outflow)" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={`out-${d.month}`} fillOpacity={fadeFor(i)} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
