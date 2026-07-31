import {
  Users,
  Percent,
  DollarSign,
  Clock,
  AlertTriangle,
  TrendingUp,
  Info,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { LaborHoursChart, LaborPctChart } from '@/components/charts/labor-trend-chart'
import { LaborFilters } from '@/components/labor/labor-filters'
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
import { formatCurrency, formatPercent } from '@/lib/data'
import { getBusinessSettings } from '@/lib/queries'
import {
  getLaborDataset,
  filterShifts,
  summarizeLabor,
  deriveMonthlyLabor,
  latestCompleteLaborMonth,
  laborPctWindow,
  groupLabor,
  flagLongShifts,
  monthEnd,
  OVERTIME_WEEKLY_THRESHOLD_HOURS,
  LONG_SHIFT_REVIEW_HOURS,
  type LaborGroupBy,
} from '@/lib/labor-service'

const numberFmt = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

function formatHours(hours: number): string {
  return `${numberFmt.format(Math.round(hours))} h`
}

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-')
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, 1))
  return `${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} '${y.slice(2)}`
}

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const readParam = (key: string): string | null => {
    const raw = params[key]
    const value = Array.isArray(raw) ? raw[0] : raw
    return value && value.trim() !== '' ? value : null
  }

  const [dataset, settings] = await Promise.all([
    getLaborDataset(),
    getBusinessSettings(),
  ])

  const target =
    typeof settings.target_payroll_pct === 'number'
      ? settings.target_payroll_pct
      : null
  const warning =
    typeof settings.warning_payroll_pct === 'number'
      ? settings.warning_payroll_pct
      : null

  const groupByParam = readParam('groupBy')
  const groupBy: LaborGroupBy =
    groupByParam === 'jobTitle' || groupByParam === 'location'
      ? groupByParam
      : 'employee'

  const employee = readParam('employee')
  const jobTitle = readParam('jobTitle')
  const fromMonth = readParam('from')
  const toMonth = readParam('to')

  const shifts = filterShifts(dataset.shifts, {
    employeeId: employee ?? undefined,
    jobTitle: jobTitle ?? undefined,
    from: fromMonth ? `${fromMonth}-01` : undefined,
    to: toMonth ? monthEnd(toMonth) : undefined,
  })

  const summary = summarizeLabor(shifts, dataset.coverage)
  const monthly = deriveMonthlyLabor(shifts, dataset.coverage)
  const headline = latestCompleteLaborMonth(monthly)
  // Computed from the FILTERED series on purpose, so the comparison windows
  // describe the same rows the rest of the page is showing.
  const rolling3 = laborPctWindow(monthly, 3)
  const allTime = laborPctWindow(monthly, null)
  const groups = groupLabor(shifts, groupBy)
  const flags = flagLongShifts(shifts)

  // Month options come from every synced shift, not the filtered set, so the
  // range selector never loses the option needed to widen the range again.
  const allMonths = [
    ...new Set(dataset.shifts.map((s) => s.localDate.slice(0, 7))),
  ]
    .sort()
    .map((key) => ({ key, label: monthLabel(key) }))

  if (dataset.empty) {
    return (
      <div className="mx-auto max-w-7xl">
        <PageHeader
          title="Payroll &amp; Labor"
          description="Labor cost from Square timecards."
        />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No timecards synced yet</CardTitle>
            <CardDescription>
              Run a Square sync from Settings to pull labor timecards. Until then
              there is nothing to measure.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  const headlinePct = headline?.laborPct ?? null
  const overTarget =
    headlinePct !== null && target !== null ? headlinePct > target : false

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Payroll &amp; Labor"
        description="Labor cost, hours, and overtime derived from Square timecards."
      />

      {/* Estimate provenance is stated once, prominently, rather than buried in a
          footnote — these figures are not payroll and must not be filed as such. */}
      <Card className="mb-4 border-l-4 border-l-[var(--chart-2)]">
        <CardContent className="flex items-start gap-3 py-4">
          <Info
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="text-sm leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">
              These are timecard estimates, not payroll.
            </span>{' '}
            Square&apos;s Payroll API is access-restricted, so gross-to-net, tax
            withholding, employer taxes, and benefits are not available. Figures
            below are payable hours multiplied by each shift&apos;s wage — a floor
            for labor cost, not what was actually paid.
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardContent className="py-4">
          <LaborFilters
            employees={dataset.options.employees}
            jobTitles={dataset.options.jobTitles}
            months={allMonths}
            current={{ employee, jobTitle, from: fromMonth, to: toMonth }}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Labor % of Sales"
          value={headlinePct !== null ? formatPercent(headlinePct) : '—'}
          icon={Percent}
          {...(headlinePct !== null && target !== null
            ? {
                change: Number(Math.abs(headlinePct - target).toFixed(1)),
                trend: overTarget ? ('up' as const) : ('down' as const),
                goodDirection: 'down' as const,
                changeLabel: overTarget
                  ? `over ${formatPercent(target, 0)} target`
                  : `under ${formatPercent(target, 0)} target`,
              }
            : {})}
          hint={
            headline
              ? // The headline is one month; the wider windows say whether it is
                // representative. Both are dollar-weighted over complete months.
                `${headline.month} — last month with complete sales coverage${
                  rolling3.laborPct != null
                    ? ` · last ${rolling3.monthsCounted} mo ${formatPercent(rolling3.laborPct)}`
                    : ''
                }${
                  allTime.laborPct != null
                    ? ` · all ${allTime.monthsCounted} mo ${formatPercent(allTime.laborPct)}`
                    : ''
                }`
              : 'No month has complete sales coverage yet'
          }
        />
        <StatCard
          label="Estimated Labor Cost"
          value={formatCurrency(summary.estimatedGrossLabor)}
          icon={DollarSign}
          hint={`${summary.shiftCount.toLocaleString()} shifts in range`}
        />
        <StatCard
          label="Payable Hours"
          value={formatHours(summary.payableHours)}
          icon={Clock}
          hint={`${formatHours(summary.unpaidBreakHours)} unpaid breaks excluded`}
        />
        <StatCard
          label="Active Employees"
          value={String(summary.activeEmployees)}
          icon={Users}
          hint="Distinct people with shifts in range"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Sales per Labor Hour"
          value={
            summary.salesPerLaborHour !== null
              ? formatCurrency(summary.salesPerLaborHour)
              : '—'
          }
          icon={TrendingUp}
          hint="Net sales per payable hour, complete months only"
        />
        <StatCard
          label="Overtime Hours"
          value={formatHours(summary.overtimeHours)}
          icon={Clock}
          hint={`${summary.overtimeWeeks} week(s) over ${OVERTIME_WEEKLY_THRESHOLD_HOURS}h`}
        />
        <StatCard
          label="Est. Overtime Premium"
          value={formatCurrency(summary.estimatedOvertimeCost)}
          icon={DollarSign}
          hint="Extra half-rate above 40h/week"
        />
        <StatCard
          label="Shifts Needing Review"
          value={String(flags.length)}
          icon={AlertTriangle}
          hint={`Over ${LONG_SHIFT_REVIEW_HOURS}h on the clock`}
        />
      </div>

      {(summary.unpricedShifts > 0 || summary.partialMonths.length > 0) && (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {summary.unpricedShifts > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Hours with no wage on file
                </CardTitle>
                <CardDescription>
                  {formatHours(summary.unpricedHours)} across{' '}
                  {summary.unpricedShifts} shift(s) contribute $0 to the cost
                  above. Set a wage in Square to include them.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Who</TableHead>
                      <TableHead className="text-right">Shifts</TableHead>
                      <TableHead className="text-right">Hours</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.unpricedBy.map((u) => (
                      <TableRow key={u.label}>
                        <TableCell className="font-medium">{u.label}</TableCell>
                        <TableCell className="text-right font-mono">
                          {u.shifts}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {u.hours.toFixed(1)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {summary.partialMonths.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Months excluded from ratios
                </CardTitle>
                <CardDescription>
                  These months have labor but incomplete Square sales coverage, so
                  labor % of sales would be misleading and is left blank rather
                  than shown.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {summary.partialMonths.map((m) => (
                  <Badge key={m} variant="secondary" className="font-mono">
                    {monthLabel(m)}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Labor % of Sales</CardTitle>
            <CardDescription>
              {target !== null
                ? `Complete months vs the ${formatPercent(target, 0)} target`
                : 'Complete months only — no target set'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LaborPctChart data={monthly} target={target} warning={warning} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payable Hours by Month</CardTitle>
            <CardDescription>
              Unpaid breaks excluded. Faded bars are partial months.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LaborHoursChart data={monthly} />
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">
            Labor Cost by{' '}
            {groupBy === 'employee'
              ? 'Employee'
              : groupBy === 'jobTitle'
                ? 'Job Title'
                : 'Location'}
          </CardTitle>
          <CardDescription>
            Highest estimated cost first. Hours with no wage on file are listed
            separately so they are not mistaken for free labor.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {groupBy === 'employee'
                      ? 'Employee'
                      : groupBy === 'jobTitle'
                        ? 'Job title'
                        : 'Location'}
                  </TableHead>
                  <TableHead className="text-right">Shifts</TableHead>
                  <TableHead className="text-right">Payable hours</TableHead>
                  <TableHead className="text-right">Avg rate</TableHead>
                  <TableHead className="text-right">Overtime h</TableHead>
                  <TableHead className="text-right">Est. cost</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.key}>
                    <TableCell className="font-medium">
                      {g.label}
                      {g.unpricedShifts > 0 && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          ({g.unpricedHours.toFixed(1)} h unpriced)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {g.shiftCount}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {g.payableHours.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {g.averageRate !== null ? formatCurrency(g.averageRate) : '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {g.overtimeHours > 0 ? g.overtimeHours.toFixed(1) : '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCurrency(g.estimatedGrossLabor)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatPercent(g.share * 100, 1)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {flags.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">Shifts to Review</CardTitle>
            <CardDescription>
              Over {LONG_SHIFT_REVIEW_HOURS} hours on the clock. Shifts flagged as
              a missed clock-out are excluded from all cost figures above, because
              a forgotten clock-out is a data error, not labor.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead>Job title</TableHead>
                    <TableHead className="text-right">On clock</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flags.slice(0, 25).map((f) => (
                    <TableRow key={f.shiftId}>
                      <TableCell className="font-mono text-sm">
                        {f.localDate}
                      </TableCell>
                      <TableCell className="font-medium">
                        {f.employeeName}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {f.jobTitle || '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {f.onClockHours.toFixed(1)} h
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            f.reason === 'missed-clock-out'
                              ? 'destructive'
                              : 'secondary'
                          }
                        >
                          {f.reason === 'missed-clock-out'
                            ? 'Likely missed clock-out'
                            : 'Long shift'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {dataset.exclusions.openShifts > 0 && (
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          {dataset.exclusions.openShifts} open shift(s) with no clock-out time are
          excluded from every figure on this page.
        </p>
      )}
    </div>
  )
}
