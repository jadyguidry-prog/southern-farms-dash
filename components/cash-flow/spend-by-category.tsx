import { AlertTriangle, Info } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { formatCurrency } from '@/lib/data'
import {
  CATEGORY_MERGE_SUGGESTIONS,
  UNCATEGORIZED,
  type SpendByCategory as SpendByCategoryData,
} from '@/lib/cash-flow-service'

/**
 * Spend grouped by category, using the transaction's own category when set and
 * otherwise the vendor's default.
 *
 * Bars are plain divs rather than a chart component: with a dozen categories a
 * ranked horizontal list reads faster than a pie, and it stays legible on a
 * phone.
 */
export function SpendByCategory({ data }: { data: SpendByCategoryData }) {
  const rows = data.categories.filter((c) => c.amount > 0)
  const max = rows.length > 0 ? Math.max(...rows.map((c) => c.amount)) : 0
  const merged = rows.filter((c) => c.mergedFrom.length > 0)

  // Only suggest merges for values actually present in the data.
  const present = new Set(rows.map((c) => c.category))
  const suggestions = CATEGORY_MERGE_SUGGESTIONS.map((s) => ({
    ...s,
    values: s.values.filter((v) => present.has(v)),
  })).filter((s) => s.values.length > 1)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Spending by Category</CardTitle>
        <CardDescription>
          {data.totalSpend > 0
            ? `${formatCurrency(data.categorizedSpend)} of ${formatCurrency(
                data.totalSpend,
              )} classified (${(data.coverage * 100).toFixed(0)}% of dollars)`
            : 'No spending found in the imported transactions yet.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing to categorize yet.
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {rows.map((c) => {
                const isUnknown = c.category === UNCATEGORIZED
                return (
                  <li key={c.category} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span
                        className={
                          isUnknown
                            ? 'truncate text-sm text-muted-foreground'
                            : 'truncate text-sm font-medium text-foreground'
                        }
                      >
                        {c.category}
                        {c.mergedFrom.length > 0 && (
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                            (merged)
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 font-mono text-sm text-foreground">
                        {formatCurrency(c.amount)}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {(c.share * 100).toFixed(1)}%
                        </span>
                      </span>
                    </div>
                    <div
                      className="h-2 w-full overflow-hidden rounded-full bg-secondary"
                      role="presentation"
                    >
                      <div
                        className={
                          isUnknown ? 'h-full bg-muted-foreground/40' : 'h-full bg-primary'
                        }
                        style={{ width: `${max > 0 ? (c.amount / max) * 100 : 0}%` }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>

            {merged.length > 0 && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
                <Info
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="text-xs text-muted-foreground text-pretty">
                  Grouped for reporting only; your saved values are unchanged.{' '}
                  {merged
                    .map((c) => `${c.mergedFrom.join(' + ')} → ${c.category}`)
                    .join('; ')}
                  .
                </p>
              </div>
            )}

            {suggestions.length > 0 && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-border p-3">
                <Info
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="text-xs text-muted-foreground text-pretty">
                  Possible duplicates left separate because only you can say if
                  they&apos;re the same spend:{' '}
                  {suggestions.map((s) => s.values.join(' vs ')).join('; ')}.
                </p>
              </div>
            )}

            {data.suspectedMistyped.length > 0 && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <p className="text-xs text-muted-foreground text-pretty">
                  <span className="font-medium text-foreground">
                    Looks like a data-entry slip.
                  </span>{' '}
                  {data.suspectedMistyped
                    .map(
                      (m) =>
                        `${m.count} ${
                          m.count === 1 ? 'transaction' : 'transactions'
                        } totalling ${formatCurrency(m.amount)} are categorized “${
                          m.category
                        }” but recorded as money going out`,
                    )
                    .join('; ')}
                  . Nothing was changed automatically — correct the transaction type
                  on the Vendors page if these are deposits.
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
