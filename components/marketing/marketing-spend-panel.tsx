import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatCurrency } from '@/lib/data'
import type {
  CurrentMarketingSpend,
  Seasonality,
  SpendReconciliation,
  UncategorizedMarketing,
} from '@/lib/marketing-affordability-service'

function monthLabel(monthKey: string) {
  const [y, m] = monthKey.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

/** What is being spent today, and which months historically deserve the money. */
export function MarketingSpendPanel({
  spend,
  seasonality,
  commitmentMismatch,
  uncategorizedMarketing,
  reconciliation,
}: {
  spend: CurrentMarketingSpend
  seasonality: Seasonality
  commitmentMismatch: { committed: number; actual: number } | null
  uncategorizedMarketing: UncategorizedMarketing
  reconciliation: SpendReconciliation
}) {
  // One derivation, used by both the header warning and the callout below, so
  // the two can never disagree about whether the figures are trustworthy.
  const understated = uncategorizedMarketing.channels.length > 0
  const peak = Math.max(1, ...spend.monthly.map((m) => m.amount))
  const observed = seasonality.months.filter((m) => m.years > 0)
  const maxIndex = Math.max(1, ...observed.map((m) => m.index))

  return (
    <div className="flex flex-col gap-6">
      <Card className="gap-0 py-0">
        <CardHeader className="p-6 pb-0">
          <CardTitle>What you spend on marketing today</CardTitle>
          <CardDescription className="text-pretty">
            Pulled from categorized transactions and vendors marked as marketing.
            {/* Stated up front, because the four figures below are read at a
                glance and are badly understated when advertising is uncategorized. */}
            {understated
              ? ' These figures are lower than your real spend — see the uncategorized advertising below.'
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 p-6">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { label: 'Last active month', value: spend.currentMonth },
              { label: '3-month average', value: spend.avg3Month },
              { label: '12-month average', value: spend.avg12Month },
              { label: 'Past 12 months', value: spend.annualTotal },
            ].map((s) => (
              <div key={s.label}>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {s.label}
                </dt>
                <dd className="mt-1 font-mono text-lg font-semibold text-foreground">
                  {formatCurrency(s.value)}
                </dd>
              </div>
            ))}
          </dl>

          {/* The usual reason this whole panel reads far too low: real ad spend
              that was never categorized, so every figure above excludes it. */}
          {understated && (
            <div className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
              <div className="flex flex-col gap-1.5">
                <p className="text-pretty text-sm font-semibold text-foreground">
                  {formatCurrency(uncategorizedMarketing.total)} of advertising is not
                  counted above because it has no category
                </p>
                <p className="text-pretty text-sm leading-relaxed text-foreground">
                  These charges look like marketing but are filed under a blank
                  category, so they are missing from every figure on this page. That
                  is roughly{' '}
                  <span className="font-mono font-semibold">
                    {formatCurrency(uncategorizedMarketing.impliedMonthly)}
                  </span>{' '}
                  a month across the{' '}
                  {uncategorizedMarketing.monthsSpanned}{' '}
                  {uncategorizedMarketing.monthsSpanned === 1 ? 'month' : 'months'} they
                  appear in. Set their category to Marketing on the Transactions page
                  and these numbers will reflect what you actually spend.
                </p>
              </div>
              {/* No flex-wrap on the rows: on a phone the amount wrapped to its
                  own line and left-aligned, which read as a broken row. The
                  label shrinks instead and the amount stays pinned right. */}
              <ul className="flex flex-col gap-1.5">
                {uncategorizedMarketing.channels.map((c) => (
                  <li
                    key={c.channel}
                    className="flex items-baseline justify-between gap-x-3 border-t border-amber-500/20 pt-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 font-medium text-foreground">
                      {c.channel}
                      <span className="ml-2 whitespace-nowrap font-normal text-muted-foreground">
                        {c.count} {c.count === 1 ? 'charge' : 'charges'}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono font-semibold tabular-nums text-foreground">
                      {formatCurrency(c.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Channels that billed regularly and then vanished from the feed. The
              averages above treat them as stopped, which is wrong if the owner is
              still paying them by a route the export carries no payee for. */}
          {reconciliation.lapsed.length > 0 && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-4">
              <div className="flex flex-col gap-1.5">
                <p className="text-pretty text-sm font-semibold text-foreground">
                  These channels stopped appearing in the bank feed
                </p>
                <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
                  Each billed for a while and then stopped. If you are still paying them,
                  the charges are arriving by a route this feed cannot identify — most
                  likely a check — so they are missing from every figure above. Each
                  amount is the average for the months that channel actually billed;
                  they cover different periods, so they do not add up to a monthly total.
                </p>
              </div>
              <ul className="flex flex-col gap-1.5">
                {reconciliation.lapsed.map((l) => (
                  <li
                    key={l.channel}
                    className="flex items-baseline justify-between gap-x-3 border-t border-border pt-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 font-medium text-foreground">
                      {l.channel}
                      <span className="ml-2 whitespace-nowrap font-normal text-muted-foreground">
                        last seen {l.lastDate}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono font-semibold tabular-nums text-foreground">
                      {formatCurrency(l.typicalMonthly)}
                      <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">
                        /mo
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {reconciliation.unattributable.count > 0 && (
                <p className="text-pretty border-t border-border pt-2 text-sm leading-relaxed text-muted-foreground">
                  Separately,{' '}
                  <span className="font-mono font-semibold text-foreground">
                    {formatCurrency(reconciliation.unattributable.total)}
                  </span>{' '}
                  across {reconciliation.unattributable.count} rows has no payee in the
                  bank export at all — described only as CHECK, TRANSFER and similar. No
                  rule can tell what any of it paid for, so marketing paid this way
                  cannot be measured from this data. That is a gap in the data, not
                  evidence that marketing stopped.{' '}
                  {reconciliation.resolved.count > 0 && (
                    <>
                      The {reconciliation.resolved.count} you have already identified on
                      Check Resolution are excluded from that figure.{' '}
                    </>
                  )}
                  Identifying them there is the only way to see them: a bank feed cannot
                  help, because banks do not record who a check was written to.
                </p>
              )}
            </div>
          )}

          {commitmentMismatch && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
              {/* The gap fires in BOTH directions (the service uses Math.abs), so the
                  wording must follow the direction. This previously hardcoded the
                  underspend phrasing — "a commitment you are not actually paying",
                  "but only $X is leaving the bank" — and printed it against
                  $1,045 actual vs $750 committed, i.e. it called OVERspending an
                  unpaid commitment and told the owner to suspect a stale bill when
                  the truth was the opposite. */}
              <p className="text-sm font-semibold text-foreground text-pretty">
                {commitmentMismatch.actual > commitmentMismatch.committed
                  ? 'You are spending more on marketing than your recurring bills budget for'
                  : 'Your recurring bills list a marketing commitment you are not actually paying'}
              </p>
              <p className="text-sm leading-relaxed text-foreground text-pretty">
                Cash obligations budget{' '}
                <span className="font-mono font-semibold">
                  {formatCurrency(commitmentMismatch.committed)}
                </span>{' '}
                a month for marketing, but{' '}
                {commitmentMismatch.actual > commitmentMismatch.committed ? '' : 'only '}
                <span className="font-mono font-semibold">
                  {formatCurrency(commitmentMismatch.actual)}
                </span>{' '}
                is leaving the bank under that category.{' '}
                {/* Without this the two callouts contradict each other: one says
                    $1,192/mo of ads exists, the other that only $16 is spent. */}
                {understated
                  ? 'The uncategorized advertising above almost certainly accounts for this, so fix those categories first and then re-check this figure.'
                  : commitmentMismatch.actual > commitmentMismatch.committed
                    ? 'The obligation is understating what marketing really costs, so your cash forecast is more optimistic than reality. Raise the obligation to match what you are actually spending.'
                    : 'Either the commitment is stale and is making every cash forecast look worse than reality, or marketing is being paid from somewhere these books do not see.'}
              </p>
            </div>
          )}

          {spend.monthly.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Monthly marketing spend
              </p>
              <div className="flex items-end gap-1.5" role="img" aria-label="Monthly marketing spend">
                {spend.monthly.map((m) => (
                  <div key={m.monthKey} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                    <div className="flex h-24 w-full items-end">
                      <div
                        className="w-full rounded-t bg-primary"
                        style={{ height: `${Math.max(2, (m.amount / peak) * 100)}%` }}
                        title={`${monthLabel(m.monthKey)}: ${formatCurrency(m.amount)}`}
                      />
                    </div>
                    <span className="w-full truncate text-center text-[10px] text-muted-foreground">
                      {monthLabel(m.monthKey)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {spend.channels.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Where it goes
              </p>
              <ul className="flex flex-col divide-y divide-border">
                {spend.channels.slice(0, 8).map((c) => (
                  <li key={c.name} className="flex items-center justify-between gap-4 py-2">
                    <span className="min-w-0 truncate text-sm text-foreground">{c.name}</span>
                    <span className="shrink-0 font-mono text-sm font-semibold text-foreground">
                      {formatCurrency(c.amount)}
                      <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">
                        {c.count} {c.count === 1 ? 'charge' : 'charges'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="p-6 pb-0">
          <CardTitle>When marketing money works hardest</CardTitle>
          <CardDescription className="text-pretty">
            Built from your Square sales history, weighting recent years more heavily. Above the
            line is a busier-than-average month.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 p-6">
          <div className="flex items-end gap-1" role="img" aria-label="Sales seasonality by month">
            {seasonality.months.map((m) => {
              const isNext = seasonality.nextMonth?.month === m.month
              const height = m.years > 0 ? (m.index / maxIndex) * 100 : 0
              return (
                <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                  <div className="flex h-28 w-full items-end">
                    <div
                      className={cn(
                        'w-full rounded-t',
                        m.years === 0
                          ? 'bg-muted'
                          : isNext
                            ? 'bg-primary'
                            : m.index >= 1
                              ? 'bg-emerald-600/70'
                              : 'bg-border',
                      )}
                      style={{ height: `${Math.max(2, height)}%` }}
                      title={
                        m.years > 0
                          ? `${m.label}: ${(m.index * 100).toFixed(0)}% of an average month`
                          : `${m.label}: no sales history yet`
                      }
                    />
                  </div>
                  <span
                    className={cn(
                      'text-[10px]',
                      isNext ? 'font-semibold text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {m.label.slice(0, 3)}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="flex flex-col gap-1 text-sm leading-relaxed text-muted-foreground text-pretty">
            <p>
              Busiest: <span className="font-medium text-foreground">{seasonality.strongMonths.join(', ')}</span>
            </p>
            <p>
              Quietest: <span className="font-medium text-foreground">{seasonality.weakMonths.join(', ')}</span>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
