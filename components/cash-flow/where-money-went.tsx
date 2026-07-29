import { HelpCircle } from 'lucide-react'
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
import type { OutflowsByPayee } from '@/lib/cash-flow-service'

/**
 * Ranked outflows by payee.
 *
 * Spend the bank never attributed to anyone (checks, counter withdrawals) is
 * shown in its own panel rather than as a row in the ranking. On this data
 * that's the single largest block of money, and listing it as a payee would
 * present "Check" as the business's biggest vendor.
 */
export function WhereMoneyWent({
  outflows,
  limit = 12,
}: {
  outflows: OutflowsByPayee
  limit?: number
}) {
  const top = outflows.payees.slice(0, limit)
  const remainder = outflows.payees.slice(limit)
  const remainderTotal = remainder.reduce((s, p) => s + p.amount, 0)
  const hasData = outflows.totalOutflow > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Where the Money Went</CardTitle>
        <CardDescription>
          Outflows ranked by payee across all imported transactions. Transfers
          between your own accounts and credit-card payments are excluded so
          purchases aren&apos;t counted twice.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No outflows found in the imported transactions yet.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Payee</TableHead>
                    <TableHead className="text-right">Spend</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">
                      Txns
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {top.map((p) => (
                    <TableRow key={p.key}>
                      <TableCell className="max-w-[16rem] truncate font-medium">
                        {p.payee}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(p.amount)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {(p.share * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell className="hidden text-right font-mono text-muted-foreground sm:table-cell">
                        {p.count}
                      </TableCell>
                    </TableRow>
                  ))}
                  {remainder.length > 0 && (
                    <TableRow className="border-t-2">
                      <TableCell className="text-muted-foreground">
                        {remainder.length} smaller{' '}
                        {remainder.length === 1 ? 'payee' : 'payees'}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {formatCurrency(remainderTotal)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {((remainderTotal / outflows.totalOutflow) * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell className="hidden text-right font-mono text-muted-foreground sm:table-cell">
                        {remainder.reduce((s, p) => s + p.count, 0)}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {outflows.unidentified.amount > 0 && (
              <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
                <div className="flex items-start gap-3">
                  <HelpCircle
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {formatCurrency(outflows.unidentified.amount)} has no payee on
                      the statement
                      <span className="ml-1 font-normal text-muted-foreground">
                        ({(outflows.unidentified.share * 100).toFixed(0)}% of
                        outflow, {outflows.unidentified.count} transactions)
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground text-pretty">
                      These are checks and withdrawals where the bank recorded only
                      the payment method, not who was paid. No rule can identify
                      them automatically — assigning them on the Vendors page is the
                      single biggest thing that would sharpen this view.
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {outflows.unidentified.groups.slice(0, 4).map((g) => (
                        <li key={g.key} className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {g.payee}
                          </span>{' '}
                          {formatCurrency(g.amount)} · {g.count}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
