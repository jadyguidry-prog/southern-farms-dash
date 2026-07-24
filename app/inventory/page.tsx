import { Package, Layers, Timer, AlertTriangle } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { InventoryCategoryChart } from '@/components/charts/inventory-category-chart'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/data'
import { getInventory, getInventoryByCategory } from '@/lib/queries'

const turnoverStyle: Record<string, string> = {
  Fast: 'bg-primary/10 text-primary',
  Medium: 'bg-chart-4/15 text-chart-4',
  Slow: 'bg-destructive/10 text-destructive',
}

export default async function InventoryPage() {
  const [inventory, inventoryByCategory] = await Promise.all([
    getInventory(),
    getInventoryByCategory(),
  ])

  const totalValue = inventory.reduce((s, i) => s + i.value, 0)
  const totalUnits = inventory.reduce((s, i) => s + i.units, 0)
  const slowItems = inventory.filter((i) => i.turnover === 'Slow')
  const avgDays = inventory.length
    ? Math.round(inventory.reduce((s, i) => s + i.daysOnHand, 0) / inventory.length)
    : 0

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Inventory"
        description="Current stock value, turnover velocity, and aging by product line."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Inventory Value" value={formatCurrency(totalValue)} icon={Package} />
        <StatCard label="Total Units On Hand" value={totalUnits.toLocaleString()} icon={Layers} />
        <StatCard label="Avg Days On Hand" value={`${avgDays} days`} icon={Timer} />
        <StatCard
          label="Slow-Moving Items"
          value={String(slowItems.length)}
          icon={AlertTriangle}
          hint="Flagged for action"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Value by Category</CardTitle>
            <CardDescription>Share of total inventory cost</CardDescription>
          </CardHeader>
          <CardContent>
            <InventoryCategoryChart data={inventoryByCategory} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Stock Detail</CardTitle>
            <CardDescription>All active SKUs</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Days</TableHead>
                    <TableHead>Turnover</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inventory.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell>
                        <div className="font-medium">{i.item}</div>
                        <div className="text-xs text-muted-foreground">
                          {i.sku} · {i.category}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {i.units.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(i.value)}
                      </TableCell>
                      <TableCell className="text-right font-mono">{i.daysOnHand}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={turnoverStyle[i.turnover]}>
                          {i.turnover}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
