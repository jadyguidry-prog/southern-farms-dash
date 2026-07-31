import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatCurrency } from '@/lib/data'
import type {
  AffordabilityScore,
  AvailableOperatingCash,
} from '@/lib/marketing-affordability-service'

/**
 * The arithmetic behind the recommendation, line by line.
 *
 * Rule: never present a number the owner cannot trace. Every deduction carries
 * the basis it came from, and receivables that were thrown out are listed with
 * the reason rather than silently dropped.
 */
export function AffordabilityBreakdown({
  cash,
  score,
}: {
  cash: AvailableOperatingCash
  score: AffordabilityScore
}) {
  const rows: { label: string; amount: number; basis: string; negative?: boolean }[] = [
    {
      label: 'Cash on hand',
      amount: cash.cashOnHand,
      basis: 'Checking and savings balances',
    },
    ...(cash.expectedReceivables > 0
      ? [
          {
            label: 'Money owed to you',
            amount: cash.expectedReceivables,
            basis: 'Unpaid invoices with a real customer and invoice number',
          },
        ]
      : []),
    ...cash.deductions.map((d) => ({
      label: d.label,
      amount: -d.amount,
      basis: d.basis,
      negative: true,
    })),
  ]

  return (
    <div className="flex flex-col gap-6">
      <Card className="gap-0 py-0">
        <CardHeader className="p-6 pb-0">
          <CardTitle>What is actually available</CardTitle>
          <CardDescription className="text-pretty">
            Every figure below comes from your own records. Nothing is estimated.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-0 p-6">
          <ul className="flex flex-col divide-y divide-border">
            {rows.map((r) => (
              <li key={r.label} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{r.label}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground text-pretty">
                    {r.basis}
                  </p>
                </div>
                <p
                  className={cn(
                    'shrink-0 font-mono text-sm font-semibold',
                    r.negative ? 'text-destructive' : 'text-foreground',
                  )}
                >
                  {r.negative ? '-' : ''}
                  {formatCurrency(Math.abs(r.amount))}
                </p>
              </li>
            ))}
          </ul>

          <div className="mt-2 flex items-center justify-between gap-4 border-t-2 border-border pt-4">
            <p className="text-sm font-semibold text-foreground">Projected cash</p>
            <p
              className={cn(
                'font-mono text-lg font-bold',
                cash.projectedCash < 0 ? 'text-destructive' : 'text-foreground',
              )}
            >
              {formatCurrency(cash.projectedCash)}
            </p>
          </div>
          <div className="flex items-center justify-between gap-4 py-2">
            <p className="text-sm text-muted-foreground">Reserve you asked to keep untouched</p>
            <p className="font-mono text-sm font-semibold text-muted-foreground">
              -{formatCurrency(cash.minCashReserve)}
            </p>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
            <p className="text-sm font-semibold text-foreground text-pretty">
              Free to spend on anything
            </p>
            <p
              className={cn(
                'font-mono text-xl font-bold',
                cash.availableOperatingCash < 0 ? 'text-destructive' : 'text-emerald-700',
              )}
            >
              {formatCurrency(cash.availableOperatingCash)}
            </p>
          </div>

          {cash.excludedReceivables.length > 0 && (
            <div className="mt-4 flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
              <p className="text-sm font-semibold text-foreground text-pretty">
                Money owed that was left out on purpose
              </p>
              <ul className="flex flex-col gap-1.5">
                {cash.excludedReceivables.map((r) => (
                  <li key={`${r.customer}-${r.amount}`} className="text-sm text-foreground">
                    <span className="font-mono font-semibold">{formatCurrency(r.amount)}</span>{' '}
                    from {r.customer} — {r.reason.toLowerCase()}
                  </li>
                ))}
              </ul>
              <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
                Counting these would hand you spending room that may not exist. Fill in the real
                customer and invoice number and they will be included automatically.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="p-6 pb-0">
          <CardTitle>How the {score.score}/100 was scored</CardTitle>
          <CardDescription className="text-pretty">{score.headline}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 p-6">
          {score.components.map((c) => {
            const pct = c.max > 0 ? (c.points / c.max) * 100 : 0
            return (
              <div key={c.label} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-foreground">{c.label}</p>
                  <p className="shrink-0 font-mono text-sm text-muted-foreground">
                    {c.points}/{c.max}
                  </p>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full',
                      pct >= 66 ? 'bg-emerald-600' : pct >= 33 ? 'bg-amber-500' : 'bg-destructive',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
                  {c.detail}
                </p>
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
