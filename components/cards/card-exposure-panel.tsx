/**
 * Credit-card exposure detail.
 *
 * Presentational only — it takes the already-computed `CardExposure` and renders it,
 * with no database or clock access of its own. That keeps it usable from the
 * dashboard, Cash & Debt and the report while guaranteeing all three show the same
 * numbers.
 *
 * THE RULES THIS COMPONENT ENFORCES VISUALLY
 *  - An unrecorded amount renders "Not recorded", NEVER $0. This card runs thousands
 *    a month; a literal $0 reads as "paid off" and understates real exposure to
 *    nothing.
 *  - An unknown credit limit renders "Limit not recorded" and no utilization bar,
 *    rather than implying unlimited headroom.
 *  - The ledger-derived figure is always labelled as derived, with its unconfirmed
 *    starting-point assumption stated next to it — never presented as the balance.
 */

import { CreditCard, AlertTriangle, CalendarClock } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/data'
import { formatOwedAmount } from '@/lib/card-activity'
import type { CardExposure } from '@/lib/card-exposure-service'

/**
 * "No value recorded" becomes words in exactly one place, shared with every other
 * surface, so no page can drift back to rendering $0 for an unknown balance.
 */
const money = formatOwedAmount

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  if (!y || !m) return monthKey
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function friendlyDate(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function CardExposurePanel({
  exposure,
  monthsShown = 6,
  className,
}: {
  exposure: CardExposure
  /** How many recent months of activity to list per card. */
  monthsShown?: number
  className?: string
}) {
  // No card accounts at all is a setup gap, not a zero. Say that plainly instead of
  // rendering an empty panel full of dashes.
  if (!exposure.hasCards) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">Credit Card Exposure</CardTitle>
          <CardDescription>
            No credit cards are set up, so card spending is not being tracked.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Credit Card Exposure</CardTitle>
            <CardDescription className="text-pretty">
              What is owed on each card, and how current the recorded spending is.
            </CardDescription>
          </div>
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
            <CreditCard className="size-5" aria-hidden="true" />
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {/* ---- Aggregate ------------------------------------------------- */}
        <div className="flex flex-wrap gap-x-8 gap-y-3 border-b pb-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Total Owed
            </p>
            <p className="mt-1 font-mono text-2xl font-bold tracking-tight text-foreground">
              {money(exposure.totalOwed)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {exposure.totalOwed === null
                ? `No balance confirmed on ${
                    exposure.cardCount === 1 ? 'the card' : 'any of the cards'
                  } yet`
                : `${exposure.confirmedCount} of ${exposure.cardCount} ${
                    exposure.cardCount === 1 ? 'card' : 'cards'
                  } confirmed`}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Spending Recorded Through
            </p>
            <p className="mt-1 font-mono text-2xl font-bold tracking-tight text-foreground">
              {exposure.lastActivityDate
                ? friendlyDate(exposure.lastActivityDate)
                : 'No history'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {exposure.behindCount > 0
                ? `${exposure.behindCount} ${
                    exposure.behindCount === 1 ? 'card is' : 'cards are'
                  } behind — import the latest statement`
                : 'Up to date with the current month'}
            </p>
          </div>
        </div>

        {/* ---- Warnings -------------------------------------------------- */}
        {exposure.warnings.length > 0 && (
          <ul className="flex flex-col gap-2">
            {exposure.warnings.map((w) => (
              <li key={w} className="flex items-start gap-2 text-sm text-pretty">
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-chart-4"
                  aria-hidden="true"
                />
                <span className="text-muted-foreground">{w}</span>
              </li>
            ))}
          </ul>
        )}

        {/* ---- Per card -------------------------------------------------- */}
        <div className="flex flex-col gap-5">
          {exposure.cards.map((card) => {
            const months = card.activity?.months.slice(0, monthsShown) ?? []
            return (
              <div key={card.accountName} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {card.accountName}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Amount owed {card.balanceLabel}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-lg font-semibold text-foreground">
                      {money(card.owed)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {card.limit === null
                        ? 'Limit not recorded'
                        : `of ${formatCurrency(card.limit, { compact: true })} limit`}
                    </p>
                  </div>
                </div>

                {/* Utilization only when a limit is actually known. Deriving a
                    percentage from an unknown limit would invent headroom. */}
                {card.utilization !== null && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {Math.round(card.utilization * 100)}% of the limit used
                    {card.headroom !== null
                      ? ` · ${formatCurrency(card.headroom)} available`
                      : ''}
                  </p>
                )}

                {card.statementDueDate && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CalendarClock className="size-3.5" aria-hidden="true" />
                    Statement {money(card.statementBalance)} due{' '}
                    {friendlyDate(card.statementDueDate)}
                    {card.daysUntilDue !== null &&
                      (card.daysUntilDue < 0
                        ? ` — ${Math.abs(card.daysUntilDue)} days overdue`
                        : ` — in ${card.daysUntilDue} days`)}
                  </p>
                )}

                {/* ---- Derived cross-check ------------------------------- */}
                {card.balanceCheck && (
                  <div className="mt-3 rounded-md bg-secondary/50 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-xs font-medium text-foreground">
                        Recorded history implies
                      </p>
                      <p className="font-mono text-sm font-semibold text-foreground">
                        {formatCurrency(card.balanceCheck.impliedNet)}
                      </p>
                    </div>
                    {card.balanceCheck.difference !== null &&
                      card.balanceCheck.status === 'differs' && (
                        <p className="mt-1 text-xs font-medium text-chart-4">
                          {formatCurrency(Math.abs(card.balanceCheck.difference))}{' '}
                          {card.balanceCheck.difference > 0 ? 'more' : 'less'} than
                          history explains
                        </p>
                      )}
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {card.balanceCheck.notes.map((n) => (
                        <li
                          key={n}
                          className="text-xs text-pretty text-muted-foreground"
                        >
                          {n}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* ---- Monthly activity ---------------------------------- */}
                {months.length > 0 ? (
                  // `relative` is required: an `sr-only` caption inside an
                  // overflow-x-auto wrapper is position:absolute, so without a
                  // positioned ancestor it anchors to the page and silently
                  // stretches the document past the viewport on a phone.
                  <div className="relative mt-3 overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="sr-only">
                        Recorded monthly activity for {card.accountName}
                      </caption>
                      <thead>
                        <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                          <th scope="col" className="py-1.5 text-left font-medium">
                            Month
                          </th>
                          <th scope="col" className="py-1.5 text-right font-medium">
                            Charged
                          </th>
                          <th scope="col" className="py-1.5 text-right font-medium">
                            Paid
                          </th>
                          <th scope="col" className="py-1.5 text-right font-medium">
                            Refunds
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {months.map((m) => (
                          <tr key={m.monthKey} className="border-b last:border-0">
                            <td className="py-1.5 text-left whitespace-nowrap">
                              {monthLabel(m.monthKey)}
                            </td>
                            <td className="py-1.5 text-right font-mono tabular-nums">
                              {formatCurrency(m.charges)}
                            </td>
                            <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                              {m.payments > 0 ? formatCurrency(m.payments) : '—'}
                            </td>
                            <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                              {m.refunds > 0 ? formatCurrency(m.refunds) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    No card transactions have been recorded for this card yet.
                  </p>
                )}

                {card.activity?.feedBehind && (
                  <Badge variant="outline" className="mt-3 text-chart-4">
                    Recorded through {friendlyDate(card.activity.lastTxnDate)}
                  </Badge>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
