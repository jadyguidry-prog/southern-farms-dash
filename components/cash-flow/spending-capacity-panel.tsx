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
import { formatCurrency, formatDayLabel } from '@/lib/data'
import type { SpendingCapacity } from '@/lib/spending-capacity-data'
import { DayOutflowRows } from './day-outflow-rows'

/** Local alias for the shared formatter, kept so existing call sites read the same. */
const dayLabel = formatDayLabel

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
    nearTermDays,
    horizonDays,
    cardPayments,
    blockedCardPayments,
    availableCredit,
    creditLines,
  } = capacity

  // The table shows the spendable window. Everything beyond it is listed separately as
  // "coming up", because a 30-row table buries the one row that matters.
  const nearTermRows = days.slice(0, nearTermDays)
  const lastNearTermDate = nearTermRows.at(-1)?.date ?? capacity.today

  // A breach INSIDE the spendable window and a breach three weeks out need different
  // wording. Telling the owner "nothing spare to spend this week" because of a payment
  // due on the 18th would contradict the headline directly above it, which is exactly how
  // two panels using different standards end up looking broken.
  //
  // Comes from the engine, which tracks the two windows separately. Deriving it here by
  // testing the horizon low point's date against the window was wrong: when cash dipped
  // under the reserve on day 6 AND fell further weeks later, only the distant warning
  // rendered and the immediate one vanished.
  const breachIsNearTerm = capacity.breachesReserveNearTerm

  // The typical-week low point WITHIN the spendable window, read off the engine's own days
  // rather than recomputed. Kept window-consistent with the banner it appears in: pairing
  // this week's cautious dip with a horizon-wide typical trough would attach an unrelated
  // date to "this week" — the same two-standards confusion the near-term split exists to
  // avoid.
  const typicalNearTermLow = nearTermRows.length
    ? nearTermRows.reduce(
        (lowest, d) => (d.typicalBalance < lowest.typicalBalance ? d : lowest),
        nearTermRows[0],
      )
    : null

  // Dated events beyond the spendable window — the cliff the old 7-day view could not see.
  //
  // Only `kind === 'dated'`. The spread estimate recurs EVERY day, so including it produced
  // ~23 identical "Day-to-day running costs" rows that buried the single $9,948 payment
  // this section exists to surface. Largest first, and capped, because the purpose is to
  // show what could hurt — not to reproduce the whole ledger.
  const datedAfterWindow = days
    .filter((d) => d.date > lastNearTermDate)
    .flatMap((d) => d.items.map((i) => ({ ...i, date: d.date })))
    .filter((i) => i.kind === 'dated' && i.amount > 0)
    .sort((a, b) => b.amount - a.amount)

  const COMING_UP_LIMIT = 6
  const comingUp = datedAfterWindow.slice(0, COMING_UP_LIMIT)
  const comingUpHidden = datedAfterWindow.length - comingUp.length
  // Stated as a total so a truncated list can't imply the hidden rows are trivial.
  const comingUpHiddenTotal = datedAfterWindow
    .slice(COMING_UP_LIMIT)
    .reduce((s, i) => s + i.amount, 0)

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
              expected costs for the next {nearTermDays} days. Card payments due
              later are checked separately, over {horizonDays} days.
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
                  a day for {nearTermDays} days
                </p>
              </div>
            </div>

            {breachIsNearTerm ? (
              <div className="mt-4 flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <TriangleAlert
                  className="size-4 shrink-0 text-destructive"
                  aria-hidden
                />
                {/* Near-term figures, not horizon ones: this banner is about the window
                    the headline covers, so quoting a low point from weeks later would
                    attach an unrelated date to "this week". */}
                <div className="text-sm text-foreground text-pretty">
                  <p>
                    On a slow week your cash dips to{' '}
                    <span className="font-medium tabular-nums">
                      {formatCurrency(capacity.nearTermLowestBalance)}
                    </span>{' '}
                    by {dayLabel(capacity.nearTermLowestBalanceDate)} &mdash;{' '}
                    <span className="font-medium tabular-nums">
                      {formatCurrency(capacity.nearTermReserveShortfall)}
                    </span>{' '}
                    under your {formatCurrency(minCashReserve)} reserve. There is
                    nothing spare to spend this week.
                  </p>
                  {/* The expected path, stated straight after the stress case. Without it the
                      headline reads as a prediction of the worst week rather than a
                      deliberately conservative floor, which is what made a defensible $0
                      look like a broken number. */}
                  {typicalNearTermLow ? (
                    <p className="mt-1.5 text-muted-foreground">
                      On a typical week it holds at{' '}
                      <span className="font-medium tabular-nums text-foreground">
                        {formatCurrency(typicalNearTermLow.typicalBalance)}
                      </span>{' '}
                      ({dayLabel(typicalNearTermLow.date)}). The figure above is the
                      cautious case, so it stays safe in a bad week.
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* Shown whenever the horizon gets materially worse than the window already
                is — not only when the window is clean. Both can be true at once, and
                suppressing this one in that case hid the larger, later cliff. */}
            {breachesReserve && lowestBalance < capacity.nearTermLowestBalance ? (
              <div className="mt-4 flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <TriangleAlert
                  className="size-4 shrink-0 text-destructive"
                  aria-hidden
                />
                <div className="text-sm text-foreground text-pretty">
                  <p>
                    {breachIsNearTerm
                      ? 'It gets worse beyond this week: on a slow week your cash falls to '
                      : 'Spendable today, but not for long: on a slow week your cash falls to '}
                    <span className="font-medium tabular-nums">
                      {formatCurrency(lowestBalance)}
                    </span>{' '}
                    by {dayLabel(lowestBalanceDate)} &mdash;{' '}
                    <span className="font-medium tabular-nums">
                      {formatCurrency(reserveShortfall)}
                    </span>{' '}
                    under your {formatCurrency(minCashReserve)} reserve.{' '}
                    {/* "Hold back X of it" is only coherent when there is something to hold
                        back. At $0 spendable the shortfall has to be closed by bringing money
                        in, so telling the owner to withhold cash they do not have would be
                        advice they cannot act on. */}
                    {breachIsNearTerm ? (
                      <>
                        Closing that gap needs money coming in, not just spending less
                        &mdash; there is nothing spare to hold back.
                      </>
                    ) : (
                      <>
                        The figure above only looks {nearTermDays} days ahead, so it does
                        not yet account for that. Hold back at least{' '}
                        <span className="font-medium tabular-nums">
                          {formatCurrency(reserveShortfall)}
                        </span>{' '}
                        of it.
                      </>
                    )}
                  </p>

                  {/* Names what "slow week" actually assumes. A trough built on repeated
                      lower-quartile weeks is defensible, but unlabelled it looks like a
                      forecast of the likely outcome, which is not what it is. */}
                  <p className="mt-1.5 text-muted-foreground">
                    That assumes {estimate.weeksObserved >= 8 ? 'every' : 'each'} week
                    brings only{' '}
                    <span className="font-medium tabular-nums text-foreground">
                      {formatCurrency(estimate.cautiousInflow)}
                    </span>{' '}
                    in, for {horizonDays} days straight. On typical weeks (
                    <span className="font-medium tabular-nums text-foreground">
                      {formatCurrency(estimate.typicalInflow)}
                    </span>{' '}
                    a week) the low point is{' '}
                    <span className="font-medium tabular-nums text-foreground">
                      {formatCurrency(capacity.typicalLowestBalance)}
                    </span>{' '}
                    on {dayLabel(capacity.typicalLowestBalanceDate)}.
                  </p>

                  {/* Borrowing capacity as context only. Stated as "not counted above" so it
                      can never be read as spendable cash — the projection deliberately
                      excludes it, and a buffer shown without that caveat would undercut the
                      warning it sits inside. */}
                  {availableCredit !== null && availableCredit > 0 ? (
                    <p className="mt-1.5 text-muted-foreground">
                      Not counted above:{' '}
                      <span className="font-medium tabular-nums text-foreground">
                        {formatCurrency(availableCredit)}
                      </span>{' '}
                      still undrawn on your{' '}
                      {creditLines.length === 1
                        ? creditLines[0].accountName
                        : `${creditLines.length} credit lines`}
                      . That is borrowing, not cash, so the forecast leaves it out
                      &mdash; but it is there if the gap has to be bridged.
                    </p>
                  ) : null}
                </div>
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

            {blockedCardPayments.length > 0 ? (
              <div className="mt-4 flex gap-3 rounded-lg border border-border bg-muted/40 p-3">
                <Info className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="text-sm text-muted-foreground text-pretty">
                  <p>
                    {/* "Not included" rather than "missing": the list mixes cards with no
                        recorded due date (data genuinely absent) with cards known to fall
                        past the window (nothing absent). Either way the low point above is
                        understated, which is the part that matters. */}
                    {blockedCardPayments.length === 1 ? 'A card payment is' : 'Some card payments are'}{' '}
                    not included in this forecast, so your real low point may be worse:
                  </p>
                  <ul className="mt-1 list-disc pl-5">
                    {blockedCardPayments.map((p) => (
                      <li key={p.accountName}>
                        {p.accountName} &mdash;{' '}
                        {/* A card that is known but merely due past the horizon gets its
                            real amount and date. Nothing is missing for it, so repeating
                            the "not enough information" phrasing used for an unrecorded
                            card would send the owner off to re-enter data they already
                            have. */}
                        {p.blockedBeyondHorizon
                          ? `${formatCurrency(p.amount)} due ${dayLabel(p.dueDate)}, past this ${horizonDays}-day window`
                          : p.blockedReason}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            <p className="mt-5 text-xs text-muted-foreground text-pretty">
              Tap a day to see exactly what makes up its total. Bills that were due
              earlier and have not cleared are charged to today, so today can look
              larger than a normal day.
            </p>
            <div className="mt-2 overflow-x-auto">
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
                  {nearTermRows.map((d) => (
                    <DayOutflowRows key={d.date} day={d} />
                  ))}
                </TableBody>
              </Table>
            </div>

            {comingUp.length > 0 ? (
              <div className="mt-5">
                <h4 className="text-sm font-medium text-foreground">
                  Coming up after day {nearTermDays}
                </h4>
                <p className="mt-1 text-xs text-muted-foreground text-pretty">
                  Known payments beyond the window above, largest first. These are already
                  counted in the low point, but not in today&apos;s spendable figure. Regular
                  day-to-day running costs are excluded here since they apply every day.
                </p>
                <ul className="mt-2 divide-y divide-border">
                  {comingUp.map((i) => (
                    <li
                      key={`${i.date}-${i.label}`}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
                    >
                      <span className="text-sm text-foreground">{i.label}</span>
                      <span className="flex items-baseline gap-3">
                        <span className="text-xs text-muted-foreground">
                          {dayLabel(i.date)}
                        </span>
                        <span className="text-sm font-medium tabular-nums text-foreground">
                          {formatCurrency(i.amount)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                {comingUpHidden > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Plus {comingUpHidden} smaller{' '}
                    {comingUpHidden === 1 ? 'payment' : 'payments'} totalling{' '}
                    <span className="tabular-nums">
                      {formatCurrency(comingUpHiddenTotal)}
                    </span>
                    , also included in the low point.
                  </p>
                ) : null}
              </div>
            ) : null}

            <p className="mt-3 text-xs text-muted-foreground text-pretty">
              Balances use the cautious (slow-week) estimate of{' '}
              {formatCurrency(estimate.cautiousInflow)} coming in per week; a
              typical week is {formatCurrency(estimate.typicalInflow)}. Starting
              cash is {formatCurrency(cashOnHand)} across your operating accounts,
              and your reserve of {formatCurrency(minCashReserve)} is held back.{' '}
              Card balances are not counted as cash, since borrowing is not money you
              have &mdash; but{' '}
              {cardPayments.length > 0
                ? 'the payment due on each card is charged on its due date, so the day it clears is visible above.'
                : 'no card payment is currently being forecast.'}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
