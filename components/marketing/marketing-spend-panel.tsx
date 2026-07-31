import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatCurrency } from '@/lib/data'
import type {
  CurrentMarketingSpend,
  Seasonality,
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
}: {
  spend: CurrentMarketingSpend
  seasonality: Seasonality
  commitmentMismatch: { committed: number; actual: number } | null
}) {
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

          {commitmentMismatch && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
              <p className="text-sm font-semibold text-foreground text-pretty">
                Your recurring bills list a marketing commitment you are not actually paying
              </p>
              <p className="text-sm leading-relaxed text-foreground text-pretty">
                Cash obligations budget{' '}
                <span className="font-mono font-semibold">
                  {formatCurrency(commitmentMismatch.committed)}
                </span>{' '}
                a month for marketing, but only{' '}
                <span className="font-mono font-semibold">
                  {formatCurrency(commitmentMismatch.actual)}
                </span>{' '}
                is leaving the bank. Either the commitment is stale and is making every cash
                forecast look worse than reality, or marketing is being paid from somewhere these
                books do not see.
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
