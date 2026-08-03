'use client'

import { Area, AreaChart, CartesianGrid, XAxis, YAxis, ReferenceLine } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

const config = {
  balance: { label: 'Typical week', color: 'var(--chart-1)' },
  cautious: { label: 'Slow week', color: 'var(--chart-4)' },
} satisfies ChartConfig

/**
 * Compact axis labels that stay readable at this business's scale.
 *
 * A flat "$Xk" rounding is wrong here: balances sit around $10-20k, so $13,658
 * and $14,400 would both render "$14K" and the line would look flat when it is
 * actually moving through the reserve. Below $50k we therefore keep the hundreds.
 */
function formatAxis(v: number) {
  const abs = Math.abs(v)
  if (abs >= 50_000) return `$${Math.round(v / 1000)}k`
  if (abs >= 1_000) return `$${(v / 1000).toFixed(1)}k`
  return `$${Math.round(v)}`
}

export function CashForecastChart({
  data,
  minBuffer,
  showCautious = true,
}: {
  data: { day: string; balance: number; cautious?: number }[]
  /**
   * The owner's minimum cash reserve, from settings. Passed in rather than
   * hardcoded so the line always matches what the business actually targets.
   */
  minBuffer: number
  showCautious?: boolean
}) {
  const hasCautious = showCautious && data.some((d) => typeof d.cautious === 'number')

  // Keep the reserve line inside the plotted range. If the reserve sits far above
  // every projected value, Recharts stretches the axis to reach it and squashes the
  // real balance into an unreadable strip at the bottom — which is exactly how the
  // old hardcoded $375,000 line broke this chart.
  const values = data.flatMap((d) =>
    [d.balance, d.cautious].filter((n): n is number => typeof n === 'number'),
  )
  const lowest = values.length > 0 ? Math.min(...values) : 0
  const highest = values.length > 0 ? Math.max(...values) : 0
  const bufferInRange = minBuffer <= highest * 1.5

  return (
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
      <AreaChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
        <defs>
          <linearGradient id="fillBalance" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-balance)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-balance)" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="fillCautious" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-cautious)" stopOpacity={0.18} />
            <stop offset="95%" stopColor="var(--color-cautious)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={formatAxis}
          domain={[
            // Always show zero when the projection approaches it, so a run to empty
            // reads as a run to empty rather than a line drifting off the bottom.
            (dataMin: number) => Math.min(0, dataMin, bufferInRange ? minBuffer : dataMin),
            (dataMax: number) => Math.max(dataMax, bufferInRange ? minBuffer : dataMax) * 1.08,
          ]}
        />
        {bufferInRange && (
          <ReferenceLine
            y={minBuffer}
            stroke="var(--chart-2)"
            strokeDasharray="4 4"
            label={{
              value: 'Reserve',
              position: 'insideTopRight',
              fill: 'var(--chart-2)',
              fontSize: 11,
            }}
          />
        )}
        {lowest < 0 && <ReferenceLine y={0} stroke="var(--destructive)" strokeWidth={1} />}
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name) => [
                `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
                name === 'cautious' ? ' Slow week' : ' Typical week',
              ]}
            />
          }
        />
        {hasCautious && (
          <Area
            dataKey="cautious"
            type="monotone"
            stroke="var(--color-cautious)"
            strokeWidth={2}
            strokeDasharray="4 3"
            fill="url(#fillCautious)"
          />
        )}
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
