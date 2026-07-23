'use client'

import { Pie, PieChart, Cell } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { inventoryByCategory } from '@/lib/data'

const colors = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
]

const config = {
  value: { label: 'Value' },
} satisfies ChartConfig

export function InventoryCategoryChart() {
  return (
    <ChartContainer config={config} className="mx-auto aspect-square h-[260px]">
      <PieChart>
        <ChartTooltip
          content={
            <ChartTooltipContent
              nameKey="category"
              formatter={(value) => `$${Number(value).toLocaleString()}`}
            />
          }
        />
        <Pie
          data={inventoryByCategory}
          dataKey="value"
          nameKey="category"
          innerRadius={60}
          outerRadius={100}
          paddingAngle={2}
        >
          {inventoryByCategory.map((_, i) => (
            <Cell key={i} fill={colors[i % colors.length]} />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  )
}
