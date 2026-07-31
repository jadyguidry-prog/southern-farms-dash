'use client'

/**
 * Review months where the reported retail figure came from a weaker source than
 * the business actually has.
 *
 * Deliberately a preview-then-apply surface with nothing pre-selected. The nine
 * flagged months do not all move the same way — six understate revenue and three
 * overstate it — so a single "fix everything" button would be a silent
 * restatement in two directions at once. The owner ticks what they accept.
 */

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowDown, ArrowUp, Lock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { applySquareSourceCorrections } from '@/app/sales/source-actions'
import type { MonthAuditRow, SalesSourceAudit } from '@/lib/sales-source-audit'

/** Cents are shown throughout: the exact figure is the point of this screen. */
function money(n: number | null): string {
  if (n == null) return '—'
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  })
}

/** "2026-06" reads as a date to a machine, not to a person. */
function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-')
  const index = Number(month) - 1
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  return names[index] ? `${names[index]} ${year}` : monthKey
}

export function SalesSourceReview({ audit }: { audit: SalesSourceAudit }) {
  // Nothing pre-selected: applying is a decision, not a default.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()

  const rows = audit.downgrades

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.month)),
    [rows, selected],
  )
  const selectedNet = useMemo(
    () => selectedRows.reduce((sum, r) => sum + r.difference, 0),
    [selectedRows],
  )

  function toggle(month: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(month)) next.delete(month)
      else next.add(month)
      return next
    })
  }

  function apply() {
    const monthKeys = [...selected]
    startTransition(async () => {
      const result = await applySquareSourceCorrections({ monthKeys })
      if (!result.ok) {
        toast.error(result.error ?? 'Could not apply the corrections.')
        return
      }
      toast.success(
        `Corrected ${result.applied} month${result.applied === 1 ? '' : 's'}. Reported retail changed by ${money(result.netChange ?? 0)}.`,
      )
      setSelected(new Set())
    })
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Revenue source check</CardTitle>
          <CardDescription>
            Every month is reporting from the best record available. Nothing to
            correct.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
          Revenue source check
        </CardTitle>
        <CardDescription className="text-pretty">
          {rows.length} month{rows.length === 1 ? '' : 's'} report retail sales
          from a bank-deposit estimate even though the till has its own record for
          the same period. A deposit is what arrived after card fees and
          holdbacks, so it does not equal what was sold. Tick the months you want
          corrected — nothing changes until you apply.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* Both directions stated up front. Leading with the net figure alone
            would hide that three of these months are currently overstated. */}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure
            label="Understated"
            value={money(
              rows.filter((r) => r.difference > 0).reduce((s, r) => s + r.difference, 0),
            )}
            hint={`${rows.filter((r) => r.difference > 0).length} months`}
          />
          <Figure
            label="Overstated"
            value={money(
              Math.abs(
                rows.filter((r) => r.difference < 0).reduce((s, r) => s + r.difference, 0),
              ),
            )}
            hint={`${rows.filter((r) => r.difference < 0).length} months`}
          />
          <Figure
            label="Net if all applied"
            value={money(audit.netDifference)}
            hint="both directions combined"
          />
          <Figure
            label="Selected"
            value={money(selectedNet)}
            hint={`${selectedRows.length} of ${rows.length} ticked`}
          />
        </dl>

        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <MonthRow
              key={row.month}
              row={row}
              checked={selected.has(row.month)}
              disabled={pending}
              onToggle={() => toggle(row.month)}
            />
          ))}
        </ul>

        {audit.lockedSkipped.length > 0 && (
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="text-pretty">
              {audit.lockedSkipped.length} closed month
              {audit.lockedSkipped.length === 1 ? '' : 's'} (
              {audit.lockedSkipped.map(monthLabel).join(', ')}) also disagree with
              the till, but they are locked and were left alone. Unlock a month
              first if you want to restate it.
            </span>
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {selectedRows.length === 0
              ? 'No months selected.'
              : `${selectedRows.length} month${selectedRows.length === 1 ? '' : 's'} selected — reported retail will change by ${money(selectedNet)}.`}
          </p>
          <Button
            onClick={apply}
            disabled={pending || selectedRows.length === 0}
            className="sm:w-auto"
          >
            {pending
              ? 'Applying…'
              : `Apply ${selectedRows.length || ''} correction${selectedRows.length === 1 ? '' : 's'}`.trim()}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Figure({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium tabular-nums text-foreground">{value}</dd>
      <dd className="text-xs text-muted-foreground">{hint}</dd>
    </div>
  )
}

function MonthRow({
  row,
  checked,
  disabled,
  onToggle,
}: {
  row: MonthAuditRow
  checked: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const id = `correct-${row.month}`
  const understated = row.difference > 0

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onToggle}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={id} className="cursor-pointer font-medium">
              {monthLabel(row.month)}
            </Label>
            <Badge
              variant="outline"
              className={
                understated
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-destructive/30 bg-destructive/10 text-destructive'
              }
            >
              {understated ? (
                <ArrowUp className="mr-1 h-3 w-3" aria-hidden="true" />
              ) : (
                <ArrowDown className="mr-1 h-3 w-3" aria-hidden="true" />
              )}
              {understated ? 'understated' : 'overstated'} by{' '}
              {money(Math.abs(row.difference))}
            </Badge>
            {row.isNegligible && (
              <Badge variant="outline" className="text-muted-foreground">
                only {row.differencePercent}% — barely matters
              </Badge>
            )}
          </div>

          {/* Before and after, side by side. The owner asked to see the months
              before applying anything, so the two figures must be comparable at
              a glance rather than described in prose. */}
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              Now (from bank):{' '}
              <span className="tabular-nums text-foreground">
                {money(row.reportedRetail)}
              </span>
            </span>
            <span className="text-muted-foreground">
              After (from till):{' '}
              <span className="tabular-nums font-medium text-foreground">
                {money(row.squareDailyRetail)}
              </span>
            </span>
          </div>
        </div>
      </div>
    </li>
  )
}
