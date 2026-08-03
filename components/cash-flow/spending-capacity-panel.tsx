import { Wallet, TriangleAlert, Info } from 'lucide-react'
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
import { formatCurrency } from '@/lib/data'
import type { SpendingCapacity } from '@/lib/spending-capacity-data'

/** "2026-08-03" -> "Mon 3 Aug", parsed as a local date so the day never shifts. */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

function confidenceNote(c: SpendingCapacity['confidence']): string | null {
  switch (c.level) {
    case 'insufficient-history':
      return c.weeksObserved === 0
        ? 'There is no complete week of transaction history yet, so sales cannot be projected and no figure is shown.'
        : `Based on only ${c.weeksObserved} complete ${c.weeksObserved === 1 ? 'week' : 'weeks'} of history. Treat this as a rough guide until more weeks are imported.`
    case 'no-income-pattern':
      return 'No repeating weekly deposit pattern was found, so money coming in is spread evenly across the week rather than by day.'
    case 'stale-data':
      return `The newest bank transaction is ${c.daysStale} days old, so today's starting cash may be out of date. Sync your accounts for an accurate figure.`
    default:
      return null
  }
}

/**
 * "Safe to spend" plus the 7-day working that produced it.
 *
 * The headline uses the CAUTIOUS (slow-week) sales estimate on purpose: a number
 * the owner acts on should hold up in a bad week, not just an average one. The
 * typical figure is shown beside it so the range is visible rather than implied.
 *
 * When the projection dips below the cash reserve, the number is deliberately
 * $0 and the panel explains the shortfall instead of suggesting a "safe" amount
 * that would quietly eat the buffer.
 */
export function SpendingCapacityPanel({ capacity }: { capacity: SpendingCapacity }) {
  const note = confidenceNote(capacity.confidence)
  // With no complete week there is no sales estimate at all, so the panel
  // explains the gap instead of printing a number built on nothing.
  const unusable =
    capacity.confidence.level === 'insufficient-history' &&
    capacity.confidence.weeksObserved === 0

  const {
    safeToSpendToday,
    perDayAllowance,
    days,
    breachesReserve,
    reserveShortfall,
    lowestBalance,
    lowestBalanceDate,
    minCashReserve,
    cashOnHand,
    estimate,
  } = capacity

  // With no reserve configured, this figure is what it takes to run the account to
  // zero. That is a legitimate calculation but reckless advice to present bare, so
  // the panel says so rather than letting a big number imply it is safe.
  const noReserveSet = minCashReserve <= 0

  // Structural check: if a typical week spends more than it takes in, spare cash is
  // being drawn down regardless of today's balance. The owner needs that context,
  // because "safe to spend" otherwise reads as a surplus that does not exist.
  const weeklyGap = estimate.typicalInflow - estimate.typicalOutflow
  const runningAtLoss = estimate.weeksObserved >= 8 && weeklyGap < 0

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">Safe to Spend</CardTitle>
            <CardDescription className="text-pretty">
              What today&apos;s cash can cover after your reserve, bills, and
              expected costs for the next 7 days
            </CardDescription>
          </div>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Wallet className="size-4" aria-hidden />
          </span>
        </div>
      </CardHeader>

      <CardContent>
        {unusable ? (
          <p className="text-sm text-muted-foreground text-pretty">{note}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <div>
                <p className="text-3xl font-semibold tabular-nums text-foreground">
                  {formatCurrency(safeToSpendToday)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  available today
                </p>
              </div>
              <div>
                <p className="text-xl font-medium tabular-nums text-foreground">
                  {formatCurrency(perDayAllowance)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  a day for 7 days
                </p>
              </div>
            </div>

            {breachesReserve ? (
              <div className="mt-4 flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <TriangleAlert
                  className="size-4 shrink-0 text-destructive"
                  aria-hidden
                />
                <p className="text-sm text-foreground text-pretty">
                  On a slow week your cash dips to{' '}
                  <span className="font-medium tabular-nums">
                    {formatCurrency(lowestBalance)}
                  </span>{' '}
                  by {dayLabel(lowestBalanceDate)} &mdash;{' '}
                  <span className="font-medium tabular-nums">
                    {formatCurrency(reserveShortfall)}
                  </span>{' '}
                  under your {formatCurrency(minCashReserve)} reserve. There is
                  nothing spare to spend this week.
                </p>
              </div>
            ) : null}

            {runningAtLoss ? (
              <div className="mt-4 flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <TriangleAlert
                  className="size-4 shrink-0 text-destructive"
                  aria-hidden
                />
                <p className="text-sm text-foreground text-pretty">
                  Read this before spending: a typical week brings in{' '}
                  <span className="font-medium tabular-nums">
                    {formatCurrency(estimate.typicalInflow)}
                  </span>{' '}
                  but pays out{' '}
                  <span className="font-medium tabular-nums">
                    {formatCurrency(estimate.typicalOutflow)}
                  </span>{' '}
                  &mdash; about{' '}
                  <span className="font-medium tabular-nums">
                    {formatCurrency(Math.abs(weeklyGap))}
                  </span>{' '}
                  more going out than coming in. The figure above is spare cash you
                  hold right now, not profit. Spending it brings the day you run
                  short closer.
                </p>
              </div>
            ) : null}

            {noReserveSet ? (
              <div className="mt-4 flex gap-3 rounded-lg border border-border bg-muted/40 p-3">
                <Info className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <p className="text-sm text-muted-foreground text-pretty">
                  You have no minimum cash reserve set, so this figure is the amount
                  that would take your account down to{' '}
                  <span className="font-medium tabular-nums">$0</span>. Set a reserve
                  in Settings and it will be held back automatically.
                </p>
              </div>
            ) : null}

            {note ? (
              <div className="mt-4 flex gap-3 rounded-lg border border-border bg-muted/40 p-3">
                <Info className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <p className="text-sm text-muted-foreground text-pretty">{note}</p>
              </div>
            ) : null}

            <div className="mt-5 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    <TableHead className="text-right">Expected in</TableHead>
                    <TableHead className="text-right">Out</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {days.map((d) => (
                    <TableRow
                      key={d.date}
                      className={d.breachesReserve ? 'bg-destructive/5' : undefined}
                    >
                      <TableCell className="whitespace-nowrap font-medium">
                        {dayLabel(d.date)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {d.cautiousIn > 0 ? formatCurrency(d.cautiousIn) : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {d.moneyOut > 0 ? (
                          <span title={d.items.map((i) => i.label).join(', ')}>
                            {formatCurrency(d.moneyOut)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums font-medium ${
                          d.breachesReserve ? 'text-destructive' : 'text-foreground'
                        }`}
                      >
                        {formatCurrency(d.cautiousBalance)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <p className="mt-3 text-xs text-muted-foreground text-pretty">
              Balances use the cautious (slow-week) estimate of{' '}
              {formatCurrency(estimate.cautiousInflow)} coming in per week; a
              typical week is {formatCurrency(estimate.typicalInflow)}. Starting
              cash is {formatCurrency(cashOnHand)} across your operating accounts,
              and your reserve of {formatCurrency(minCashReserve)} is held back.
              Credit cards are excluded, since borrowing is not cash on hand.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
