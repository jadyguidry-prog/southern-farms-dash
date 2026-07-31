'use client'

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

const hoursConfig = {
  payableHours: { label: 'Payable hours', color: 'var(--chart-1)' },
} satisfies ChartConfig

const pctConfig = {
  laborPct: { label: 'Labor % of sales', color: 'var(--chart-1)' },
} satisfies ChartConfig

export type LaborTrendPoint = {
  monthKey: string
  month: string
  payableHours: number
  estimatedGrossLabor: number
  laborPct: number | null
  partial: boolean
}

/**
 * Payable hours per month.
 *
 * Hours are shown even for partial months — hours are a fact regardless of
 * whether sales coverage is complete — but partial bars are muted so they are
 * not read as a real drop in staffing.
 */
export function LaborHoursChart({ data }: { data: LaborTrendPoint[] }) {
  if (data.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No timecards in the selected range.
      </p>
    )
  }

  return (
    <ChartContainer config={hoursConfig} className="aspect-auto h-[280px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval="preserveStartEnd"
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(v) => `${Math.round(Number(v))}h`}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(v) => `${Number(v).toLocaleString()} h`}
              labelFormatter={(label, payload) => {
                const p = payload?.[0]?.payload as LaborTrendPoint | undefined
                return p?.partial ? `${label} (partial month)` : String(label)
              }}
            />
          }
        />
        <Bar dataKey="payableHours" radius={[4, 4, 0, 0]}>
          {data.map((d) => (
            <Cell
              key={d.monthKey}
              fill="var(--color-payableHours)"
              fillOpacity={d.partial ? 0.35 : 1}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

/**
 * Labor cost as a share of net sales, against the owner's target and warning.
 *
 * Months whose sales coverage is incomplete carry `laborPct: null` and are
 * therefore gaps in the line rather than misleading spikes — dividing a full
 * month of labor by a few days of sales is what produced the 129% reading that
 * made this distinction necessary.
 */
export function LaborPctChart({
  data,
  target,
  warning,
}: {
  data: LaborTrendPoint[]
  target: number | null
  warning: number | null
}) {
  const comparable = data.filter((d) => d.laborPct !== null)

  if (comparable.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No month in this range has complete sales coverage, so labor cannot be
        compared to sales.
      </p>
    )
  }

  const maxPct = Math.max(
    target ?? 0,
    warning ?? 0,
    ...comparable.map((d) => d.laborPct as number),
  )
  const axisMax = Math.ceil((maxPct + 3) / 5) * 5

  return (
    <ChartContainer config={pctConfig} className="aspect-auto h-[280px] w-full">
      <ComposedChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval="preserveStartEnd"
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          domain={[0, axisMax]}
          tickFormatter={(v) => `${v}%`}
        />
        {typeof target === 'number' && (
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
        )}
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
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(v) => `${Number(v).toFixed(1)}%`}
              labelFormatter={(label) => String(label)}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Line
          dataKey="laborPct"
          name="Labor % of sales"
          type="monotone"
          stroke="var(--color-laborPct)"
          strokeWidth={2.5}
          dot={{ r: 3, fill: 'var(--color-laborPct)' }}
          connectNulls={false}
        />
      </ComposedChart>
    </ChartContainer>
  )
}
