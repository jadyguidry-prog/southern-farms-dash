import { AlertTriangle, CalendarClock, CheckCircle2, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency, formatDayLabel } from '@/lib/data'
import { describeReminder, type BillReminderResult } from '@/lib/bill-reminders'

/**
 * Bills needing action, plus checks that have been outstanding suspiciously long.
 *
 * Wording is deliberate: a self-scheduled bill is shown as a PLAN, never as late, because
 * no vendor deadline exists for it to miss. Mixing the two would make "overdue" mean
 * nothing.
 */
export function BillRemindersCard({ reminders }: { reminders: BillReminderResult }) {
  const { due, upcoming, staleChecks, dueTotal } = reminders
  const hasOverdue = due.some((d) => d.urgency === 'overdue')

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Bills to pay</CardTitle>
        <CalendarClock className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent>
        {due.length === 0 ? (
          <div className="flex items-start gap-2">
            <CheckCircle2
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <p className="text-sm text-muted-foreground text-pretty">
              Nothing needs paying right now.
              {upcoming.length > 0 && upcoming[0]
                ? ` Next up is ${upcoming[0].label} on ${formatDayLabel(upcoming[0].dueDate)}.`
                : ''}
            </p>
          </div>
        ) : (
          <>
            <p className="text-2xl font-semibold tabular-nums text-foreground">
              {formatCurrency(dueTotal)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              across {due.length} {due.length === 1 ? 'bill' : 'bills'}
              {hasOverdue ? ' · some past due' : ''}
            </p>

            <ul className="mt-4 flex flex-col gap-2.5">
              {due.map((r) => (
                <li key={r.id} className="flex items-baseline justify-between gap-x-4">
                  <span className="min-w-0">
                    <span className="text-sm text-foreground">{r.label}</span>
                    <span
                      className={`mt-0.5 block text-xs ${
                        r.urgency === 'overdue'
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {describeReminder(r)} · {formatDayLabel(r.dueDate)}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-foreground">
                    {formatCurrency(r.amount)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {staleChecks.length > 0 ? (
          <div className="mt-4 flex items-start gap-2 border-t border-border pt-3">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground text-pretty">
                {staleChecks.length}{' '}
                {staleChecks.length === 1 ? 'check has' : 'checks have'} been outstanding
                a long time. Still counted as owed — confirm whether they cleared.
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {staleChecks.slice(0, 3).map((c, i) => (
                  <li
                    key={`${c.checkNumber ?? 'no-number'}-${i}`}
                    className="flex items-baseline justify-between gap-x-4 text-xs"
                  >
                    <span className="min-w-0 text-muted-foreground">
                      {c.payee?.trim() ? c.payee : 'No payee recorded'}
                      {c.checkNumber ? ` · #${c.checkNumber}` : ''} ·{' '}
                      {c.daysOutstanding} days
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatCurrency(c.amount)}
                    </span>
                  </li>
                ))}
              </ul>
              {staleChecks.length > 3 ? (
                <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="size-3 shrink-0" aria-hidden />
                  {staleChecks.length - 3} more
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
