import { Users, Percent, DollarSign, Building2 } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { PayrollChart } from '@/components/charts/payroll-chart'
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
import { formatCurrency, formatPercent } from '@/lib/data'
import { getKpis, kpi, getDepartments, getPayrollTrend } from '@/lib/queries'

export default async function PayrollPage() {
  const [kpis, departments, payrollTrend] = await Promise.all([
    getKpis(),
    getDepartments(),
    getPayrollTrend(),
  ])

  const payrollPct = kpi(kpis, 'payrollPct')
  const target = Number(payrollPct.meta.target ?? 30)
  const totalMonthly = departments.reduce((s, d) => s + d.monthlyCost, 0)
  const totalEmployees = departments.reduce((s, d) => s + d.employees, 0)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Payroll"
        description="Labor cost as a percentage of sales, headcount, and departmental breakdown."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Payroll % of Sales"
          value={formatPercent(payrollPct.value)}
          icon={Percent}
          change={payrollPct.value <= target ? Number((target - payrollPct.value).toFixed(1)) : undefined}
          trend="down"
          goodDirection="down"
          changeLabel={`under ${formatPercent(target, 0)} target`}
        />
        <StatCard label="Monthly Payroll Cost" value={formatCurrency(totalMonthly)} icon={DollarSign} />
        <StatCard label="Total Employees" value={String(totalEmployees)} icon={Users} />
        <StatCard label="Departments" value={String(departments.length)} icon={Building2} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Payroll % of Sales Trend</CardTitle>
            <CardDescription>Trailing 6 months vs 30% target ceiling</CardDescription>
          </CardHeader>
          <CardContent>
            <PayrollChart data={payrollTrend} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Cost by Department</CardTitle>
            <CardDescription>Monthly labor cost and headcount</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Department</TableHead>
                  <TableHead className="text-right">Staff</TableHead>
                  <TableHead className="text-right">Monthly</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {departments.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell className="text-right font-mono">{d.employees}</TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCurrency(d.monthlyCost)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
