import { Truck, CircleDollarSign, Clock, AlertTriangle } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
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
import { getVendors } from '@/lib/queries'

const statusStyle: Record<string, string> = {
  Overdue: 'bg-destructive/10 text-destructive',
  'Due Soon': 'bg-chart-4/15 text-chart-4',
  Upcoming: 'bg-secondary text-secondary-foreground',
}

function formatDate(iso: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default async function VendorsPage() {
  const vendors = await getVendors()
  const totalPayable = vendors.reduce((s, v) => s + v.balance, 0)
  const dueSoon = vendors.filter((v) => v.status === 'Due Soon' || v.status === 'Overdue')
  const dueSoonTotal = dueSoon.reduce((s, v) => s + v.balance, 0)
  const overdue = vendors.filter((v) => v.status === 'Overdue')

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Vendor Management"
        description="Outstanding payables, payment terms, and upcoming due dates across all suppliers."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Payable" value={formatCurrency(totalPayable)} icon={CircleDollarSign} />
        <StatCard label="Active Vendors" value={String(vendors.length)} icon={Truck} />
        <StatCard label="Due Within 5 Days" value={formatCurrency(dueSoonTotal)} icon={Clock} hint={`${dueSoon.length} vendors`} />
        <StatCard label="Overdue" value={String(overdue.length)} icon={AlertTriangle} hint={overdue.length ? 'Needs attention' : 'All current'} />
      </div>

      <div className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Accounts Payable Aging</CardTitle>
            <CardDescription>Sorted by payment urgency</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vendors.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-medium">{v.name}</TableCell>
                      <TableCell className="text-muted-foreground">{v.category}</TableCell>
                      <TableCell className="font-mono text-sm">{formatDate(v.due)}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(v.balance)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={statusStyle[v.status]}>
                          {v.status}
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
