import { Store, Users, CircleDollarSign, Eye } from 'lucide-react'
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
import { wholesaleCustomers, formatCurrency } from '@/lib/data'

const statusStyle: Record<string, string> = {
  Current: 'bg-primary/10 text-primary',
  Watch: 'bg-chart-4/15 text-chart-4',
}

export default function WholesalePage() {
  const totalYtd = wholesaleCustomers.reduce((s, c) => s + c.ytd, 0)
  const totalOutstanding = wholesaleCustomers.reduce((s, c) => s + c.outstanding, 0)
  const watch = wholesaleCustomers.filter((c) => c.status === 'Watch')

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Wholesale Customers"
        description="Revenue, outstanding receivables, and payment terms for your wholesale accounts."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Wholesale Revenue YTD" value={formatCurrency(totalYtd)} icon={CircleDollarSign} />
        <StatCard label="Active Accounts" value={String(wholesaleCustomers.length)} icon={Store} />
        <StatCard label="Outstanding Receivable" value={formatCurrency(totalOutstanding)} icon={Users} />
        <StatCard label="Accounts on Watch" value={String(watch.length)} icon={Eye} hint="Slow-paying" />
      </div>

      <div className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Customer Accounts</CardTitle>
            <CardDescription>Year-to-date revenue and receivable status</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Terms</TableHead>
                    <TableHead className="text-right">YTD Revenue</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wholesaleCustomers.map((c) => (
                    <TableRow key={c.name}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-muted-foreground">{c.region}</TableCell>
                      <TableCell className="font-mono text-sm">{c.terms}</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(c.ytd)}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(c.outstanding)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={statusStyle[c.status]}>
                          {c.status}
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
