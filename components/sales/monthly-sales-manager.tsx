'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  RefreshCw,
  Lock,
  LockOpen,
  Pencil,
  AlertTriangle,
  Check,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCurrency } from '@/lib/data'
import type { MonthlySalesRow } from '@/lib/sales-service'
import type { SalesSource, UnclassifiedPayee } from '@/lib/sales-calculator'
import {
  recalculateSalesAction,
  setManualSalesAction,
  setSalesLockAction,
  addSalesRuleAction,
} from '@/app/sales/actions'

type Props = {
  rows: MonthlySalesRow[]
  unclassified: UnclassifiedPayee[]
  excludedTotal: number
}

const SOURCE_LABEL: Record<SalesSource, string> = {
  calculated: 'From bank',
  manual: 'Manual',
  mixed: 'Mixed',
  empty: 'No data',
}

/** Manual figures are the owner's stated truth, so they read as authoritative. */
function sourceVariant(source: SalesSource) {
  if (source === 'manual') return 'default' as const
  if (source === 'mixed') return 'secondary' as const
  return 'outline' as const
}

export function MonthlySalesManager({
  rows,
  unclassified,
  excludedTotal,
}: Props) {
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<string | null>(null)
  const [wholesale, setWholesale] = useState('')
  const [retail, setRetail] = useState('')

  const totalFinal = rows.reduce((s, r) => s + r.total, 0)

  function recalc() {
    startTransition(async () => {
      const res = await recalculateSalesAction()
      if (!res.ok) {
        toast.error(res.error ?? 'Recalculation failed.')
        return
      }
      const skipped = res.monthsSkippedLocked ?? 0
      toast.success(
        `Rebuilt ${res.monthsWritten ?? 0} month${res.monthsWritten === 1 ? '' : 's'} from bank records.` +
          (skipped > 0 ? ` ${skipped} locked month(s) left untouched.` : ''),
      )
    })
  }

  function beginEdit(row: MonthlySalesRow) {
    setEditing(rowKey(row))
    setWholesale(row.manualWholesale != null ? String(row.manualWholesale) : '')
    setRetail(row.manualRetail != null ? String(row.manualRetail) : '')
  }

  function saveEdit(row: MonthlySalesRow) {
    startTransition(async () => {
      const res = await setManualSalesAction({
        monthOrder: row.monthOrder,
        year: row.year,
        month: row.month,
        manualWholesale: wholesale,
        manualRetail: retail,
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save.')
        return
      }
      toast.success(
        wholesale.trim() === '' && retail.trim() === ''
          ? `Cleared override — ${row.month} ${row.year} is back to the bank figure.`
          : `Saved your figures for ${row.month} ${row.year}.`,
      )
      setEditing(null)
    })
  }

  function toggleLock(row: MonthlySalesRow) {
    if (!row.id) return
    startTransition(async () => {
      const res = await setSalesLockAction(row.id!, !row.locked)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not change lock.')
        return
      }
      toast.success(
        row.locked
          ? `${row.month} ${row.year} unlocked.`
          : `${row.month} ${row.year} locked — recalculation will skip it.`,
      )
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">Monthly sales</CardTitle>
            <CardDescription>
              Built from your imported bank records. Override any month where the
              deposits don&apos;t reflect true sales.
            </CardDescription>
          </div>
          <Button
            onClick={recalc}
            disabled={pending}
            variant="outline"
            className="w-full shrink-0 sm:w-auto"
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${pending ? 'animate-spin' : ''}`}
            />
            Recalculate
          </Button>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No sales calculated yet. Import bank transactions, then choose
              Recalculate.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {rows.map((row) => {
                const key = rowKey(row)
                const isEditing = editing === key
                const overridden =
                  row.manualWholesale != null || row.manualRetail != null
                const calcTotal =
                  (row.calculatedWholesale ?? 0) + (row.calculatedRetail ?? 0)

                return (
                  <div
                    key={key}
                    className="rounded-lg border border-border p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">
                          {row.month} {row.year}
                        </span>
                        <Badge variant={sourceVariant(row.source)}>
                          {SOURCE_LABEL[row.source]}
                        </Badge>
                        {row.locked ? (
                          <Badge variant="secondary">
                            <Lock className="mr-1 h-3 w-3" />
                            Locked
                          </Badge>
                        ) : null}
                      </div>
                      <span className="font-mono text-base font-semibold text-foreground">
                        {formatCurrency(row.total)}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
                      <span>
                        Wholesale{' '}
                        <span className="font-mono text-foreground">
                          {formatCurrency(row.wholesale)}
                        </span>
                      </span>
                      <span>
                        Retail{' '}
                        <span className="font-mono text-foreground">
                          {formatCurrency(row.retail)}
                        </span>
                      </span>
                      {row.transactionCount > 0 ? (
                        <span>{row.transactionCount} deposits</span>
                      ) : null}
                    </div>

                    {/* Show what the bank said whenever the owner has overridden
                        it, so a manual figure never silently hides the source. */}
                    {overridden && calcTotal > 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Bank records calculated {formatCurrency(calcTotal)} for
                        this month.
                      </p>
                    ) : null}

                    {isEditing ? (
                      <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`wh-${key}`}>Wholesale</Label>
                            <Input
                              id={`wh-${key}`}
                              inputMode="decimal"
                              value={wholesale}
                              onChange={(e) => setWholesale(e.target.value)}
                              placeholder={String(
                                row.calculatedWholesale ?? 0,
                              )}
                            />
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`rt-${key}`}>Retail</Label>
                            <Input
                              id={`rt-${key}`}
                              inputMode="decimal"
                              value={retail}
                              onChange={(e) => setRetail(e.target.value)}
                              placeholder={String(row.calculatedRetail ?? 0)}
                            />
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Leave both blank to remove your override and use the
                          bank figure again.
                        </p>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => saveEdit(row)}
                            disabled={pending}
                          >
                            <Check className="mr-2 h-4 w-4" />
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditing(null)}
                            disabled={pending}
                          >
                            <X className="mr-2 h-4 w-4" />
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => beginEdit(row)}
                          disabled={pending}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          {overridden ? 'Edit override' : 'Override'}
                        </Button>
                        {row.id ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleLock(row)}
                            disabled={pending}
                          >
                            {row.locked ? (
                              <LockOpen className="mr-2 h-4 w-4" />
                            ) : (
                              <Lock className="mr-2 h-4 w-4" />
                            )}
                            {row.locked ? 'Unlock' : 'Lock'}
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </div>
                )
              })}

              <div className="flex items-center justify-between border-t border-border pt-3">
                <span className="text-sm font-medium text-foreground">
                  Total across {rows.length} month
                  {rows.length === 1 ? '' : 's'}
                </span>
                <span className="font-mono text-base font-semibold text-foreground">
                  {formatCurrency(totalFinal)}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <UnclassifiedPanel
        items={unclassified}
        excludedTotal={excludedTotal}
        pending={pending}
        startTransition={startTransition}
      />
    </div>
  )
}

/**
 * Unrecognised deposits, surfaced rather than silently dropped.
 *
 * Money the calculator cannot classify is the main way sales totals go wrong, so
 * it is shown with the amount at stake and a one-click way to teach the rule.
 */
function UnclassifiedPanel({
  items,
  excludedTotal,
  pending,
  startTransition,
}: {
  items: UnclassifiedPayee[]
  excludedTotal: number
  pending: boolean
  startTransition: (cb: () => void) => void
}) {
  const [channels, setChannels] = useState<Record<string, string>>({})

  function teach(payee: string) {
    const channel = channels[payee]
    if (!channel) {
      toast.error('Choose how to treat this deposit first.')
      return
    }
    startTransition(async () => {
      const res = await addSalesRuleAction({
        matchText: payee,
        channel: channel as 'retail' | 'wholesale' | 'exclude',
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save rule.')
        return
      }
      toast.success(
        `Saved. Recalculate to apply it to ${payee}.`,
      )
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Deposits not counted as sales</CardTitle>
        <CardDescription>
          {formatCurrency(excludedTotal)} was deliberately excluded as
          transfers, loans and card advances.
          {items.length > 0
            ? ' The deposits below were not recognised at all — tell the calculator what they are.'
            : ' Every other deposit was classified.'}
        </CardDescription>
      </CardHeader>
      {items.length > 0 ? (
        <CardContent className="flex flex-col gap-3">
          {items.map((item) => (
            <div
              key={item.description}
              className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-foreground">
                    {item.description}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {formatCurrency(item.total)} across {item.count} deposit
                  {item.count === 1 ? '' : 's'}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Select
                  value={channels[item.description] ?? ''}
                  onValueChange={(v) =>
                    setChannels((prev) => ({ ...prev, [item.description]: v ?? '' }))
                  }
                >
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Treat as..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="retail">Retail sales</SelectItem>
                    <SelectItem value="wholesale">Wholesale sales</SelectItem>
                    <SelectItem value="exclude">Not a sale</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => teach(item.description)}
                  disabled={pending}
                >
                  Save
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      ) : null}
    </Card>
  )
}

function rowKey(row: MonthlySalesRow) {
  return `${row.year}-${row.monthOrder}`
}
