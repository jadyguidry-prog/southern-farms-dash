'use client'

import { PolarRadiusAxis, RadialBar, RadialBarChart, Label } from 'recharts'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'

export function RadialStat({
  value,
  max = 100,
  color = 'var(--chart-1)',
  label,
  centerText,
}: {
  value: number
  max?: number
  color?: string
  label: string
  centerText: string
}) {
  const config = { metric: { label } } satisfies ChartConfig
  const endAngle = 90 - (value / max) * 360

  return (
    <ChartContainer config={config} className="mx-auto aspect-square h-[150px]">
      <RadialBarChart
        data={[{ metric: value, fill: color }]}
        startAngle={90}
        endAngle={endAngle}
        innerRadius={60}
        outerRadius={85}
      >
        <PolarRadiusAxis tick={false} tickLine={false} axisLine={false} domain={[0, max]}>
          <Label
            content={({ viewBox }) => {
              if (viewBox && 'cx' in viewBox && 'cy' in viewBox) {
                return (
                  <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle">
                    <tspan
                      x={viewBox.cx}
                      y={(viewBox.cy ?? 0) - 4}
                      className="fill-foreground font-mono text-2xl font-bold"
                    >
                      {centerText}
                    </tspan>
                    <tspan
                      x={viewBox.cx}
                      y={(viewBox.cy ?? 0) + 16}
                      className="fill-muted-foreground text-[11px]"
                    >
                      {label}
                    </tspan>
                  </text>
                )
              }
              return null
            }}
          />
        </PolarRadiusAxis>
        <RadialBar dataKey="metric" background cornerRadius={8} />
      </RadialBarChart>
    </ChartContainer>
  )
}
