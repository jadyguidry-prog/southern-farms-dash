import { Truck, CircleDollarSign, Clock, AlertTriangle, RefreshCw } from 'lucide-react'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VendorDirectory } from '@/components/vendors/vendor-directory'
import { formatCurrency } from '@/lib/data'
import { getVendors, getVendorDirectory } from '@/lib/queries'

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
  const [vendors, directory] = await Promise.all([getVendors(), getVendorDirectory()])

  const totalPayable = vendors.reduce((s, v) => s + v.balance, 0)
  const dueSoon = vendors.filter((v) => v.status === 'Due Soon' || v.status === 'Overdue')
  const dueSoonTotal = dueSoon.reduce((s, v) => s + v.balance, 0)
  const overdue = vendors.filter((v) => v.status === 'Overdue')

  // Directory counts exclude archived vendors so the headline numbers describe
  // who the business is actively buying from.
  const activeVendors = directory.filter((v) => !v.archived && v.vendorStatus === 'Active')
  const recurringVendors = activeVendors.filter((v) => v.recurring)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Vendor Management"
        description="Your vendor directory plus outstanding payables, payment terms, and upcoming due dates across all suppliers."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active Vendors" value={String(activeVendors.length)} icon={Truck} hint={`${directory.length} total on file`} />
        <StatCard label="Recurring Vendors" value={String(recurringVendors.length)} icon={RefreshCw} hint="Regular, repeating spend" />
        <StatCard label="Total Payable" value={formatCurrency(totalPayable)} icon={CircleDollarSign} hint={totalPayable === 0 ? 'No balances entered yet' : undefined} />
        <StatCard label="Overdue" value={String(overdue.length)} icon={AlertTriangle} hint={overdue.length ? 'Needs attention' : 'All current'} />
      </div>

      <Tabs defaultValue="directory" className="mt-4">
        <TabsList>
          <TabsTrigger value="directory">Directory</TabsTrigger>
          <TabsTrigger value="payables">Payables</TabsTrigger>
        </TabsList>

        <TabsContent value="directory">
          <VendorDirectory vendors={directory} />
        </TabsContent>

        <TabsContent value="payables">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <StatCard
              label="Due Within 5 Days"
              value={formatCurrency(dueSoonTotal)}
              icon={Clock}
              hint={`${dueSoon.length} ${dueSoon.length === 1 ? 'vendor' : 'vendors'}`}
            />
            <StatCard
              label="Total Payable"
              value={formatCurrency(totalPayable)}
              icon={CircleDollarSign}
              hint={`Across ${vendors.length} ${vendors.length === 1 ? 'vendor' : 'vendors'}`}
            />
          </div>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="text-base">Accounts Payable Aging</CardTitle>
              <CardDescription>Sorted by payment urgency</CardDescription>
            </CardHeader>
            <CardContent>
              {vendors.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No vendors on file yet.
                </p>
              ) : (
                <>
                  {/* Mobile: stacked cards so nothing is cut off on a phone. */}
                  <div className="flex flex-col gap-3 md:hidden">
                    {vendors.map((v) => (
                      <div
                        key={v.id}
                        className="rounded-lg border border-border bg-card p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="font-medium text-foreground">{v.name}</span>
                          <Badge variant="secondary" className={statusStyle[v.status]}>
                            {v.status}
                          </Badge>
                        </div>
                        <dl className="mt-3 grid grid-cols-3 gap-x-4">
                          <div className="min-w-0">
                            <dt className="text-xs text-muted-foreground">Category</dt>
                            <dd className="truncate text-sm font-medium">
                              {v.category || '—'}
                            </dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-xs text-muted-foreground">Due</dt>
                            <dd className="truncate font-mono text-sm">
                              {formatDate(v.due)}
                            </dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-xs text-muted-foreground">Balance</dt>
                            <dd className="truncate font-mono text-sm">
                              {formatCurrency(v.balance)}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    ))}
                  </div>

                  {/* Desktop: full table. */}
                  <div className="hidden overflow-x-auto md:block">
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
                            <TableCell className="text-muted-foreground">
                              {v.category}
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              {formatDate(v.due)}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {formatCurrency(v.balance)}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="secondary"
                                className={statusStyle[v.status]}
                              >
                                {v.status}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
