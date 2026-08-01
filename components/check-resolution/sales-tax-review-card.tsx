'use client'

// A focused review group for sales tax still filed as an operating expense.
//
// This card is deliberately read-only until the owner picks a treatment and
// confirms. Sales tax is a judgement call about how the business is reported, so
// it is presented with its full consequences — including the one that would break
// bank reconciliation — rather than "fixed" automatically.

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ChevronDown, Receipt, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatCurrency } from '@/lib/data'
import type { SalesTaxReviewGroup, SalesTaxTreatment } from '@/lib/sales-tax-review'
import {
  applySalesTaxTreatment,
  revertBulkAction,
} from '@/app/category-review/actions'

function formatDate(iso: string): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${m}/${d}/${y?.slice(2)}`
}

export function SalesTaxReviewCard({ group }: { group: SalesTaxReviewGroup }) {
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<SalesTaxTreatment | null>(null)
  // Set once a treatment is applied, so undo stays one click away.
  const [lastAction, setLastAction] = useState<string | null>(null)

  function apply(treatment: SalesTaxTreatment) {
    startTransition(async () => {
      const res = await applySalesTaxTreatment({
        transactionIds: group.rows.map((r) => r.id),
        treatment: treatment.kind,
        category: treatment.category ?? undefined,
      })
      setConfirming(null)
      if (!res.ok) {
        toast.error('Nothing was changed', { description: res.error })
        return
      }
      setLastAction(res.bulkActionId ?? null)
      toast.success(
        treatment.kind === 'reclassify'
          ? 'Sales tax moved out of operating expenses'
          : 'Sales tax excluded from spend',
        {
          description: `${res.updated} payment${res.updated === 1 ? '' : 's'} updated. This can be undone.`,
        },
      )
    })
  }

  function undo(bulkActionId: string) {
    startTransition(async () => {
      const res = await revertBulkAction(bulkActionId)
      if (!res.ok) {
        toast.error('Could not undo', { description: res.error })
        return
      }
      setLastAction(null)
      toast.success('Change undone', {
        description: 'Every affected payment is back to how it was.',
      })
    })
  }

  return (
    <section
      aria-labelledby="sales-tax-review"
      className="rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Receipt className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <h2 id="sales-tax-review" className="text-sm font-semibold">
              Sales tax is being counted as an expense
            </h2>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground text-pretty">
              These are sales tax you collected from customers and passed on to
              the state. That money was never yours, so counting it as a cost of
              running the store overstates your expenses. Nothing has been
              changed — review it and decide.
            </p>
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 tabular-nums">
          {formatCurrency(group.totalAmount)}
        </Badge>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Payments</dt>
          <dd className="text-sm font-semibold tabular-nums">{group.count}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Total amount</dt>
          <dd className="text-sm font-semibold tabular-nums">
            {formatCurrency(group.totalAmount)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Dates</dt>
          <dd className="text-sm font-semibold tabular-nums">
            {formatDate(group.firstDate)} – {formatDate(group.lastDate)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Filed as today</dt>
          <dd className="text-sm font-semibold">
            {group.currentCategories.join(', ') || '—'}
          </dd>
        </div>
      </dl>

      {/* Every consequence, stated before the owner is asked to decide. */}
      <dl className="mt-4 flex flex-col gap-3 rounded-md bg-muted/40 p-3">
        <div>
          <dt className="text-xs font-medium">Effect on expenses</dt>
          <dd className="mt-0.5 text-xs text-muted-foreground text-pretty">
            {group.expenseImpact}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium">Effect on cash flow</dt>
          <dd className="mt-0.5 text-xs text-muted-foreground text-pretty">
            {group.cashFlowImpact}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium">
            Effect on gross profit readiness
          </dt>
          <dd className="mt-0.5 text-xs text-muted-foreground text-pretty">
            {group.grossProfitImpact}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
        {open ? 'Hide' : 'Show'} the {group.count} payments
      </button>

      {open ? (
        <ul className="mt-3 flex flex-col gap-2">
          {group.rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-xs"
            >
              <span className="font-medium tabular-nums">
                {formatDate(r.transactionDate)}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {r.description}
              </span>
              <span className="text-muted-foreground">{r.expenseCategory}</span>
              <span className="font-semibold tabular-nums">
                {formatCurrency(r.amount)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
        <p className="text-xs font-medium">How would you like this treated?</p>
        {group.treatments.map((t) => (
          <div
            key={t.kind}
            className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
          >
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-xs font-medium">
                {t.label}
                {t.recommended ? (
                  <Badge className="bg-primary text-primary-foreground">
                    Recommended
                  </Badge>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground text-pretty">
                {t.rationale}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant={t.recommended ? 'default' : 'outline'}
              disabled={pending}
              onClick={() => setConfirming(t)}
              className="shrink-0"
            >
              {t.kind === 'reclassify' ? 'Reclassify' : 'Exclude'}
            </Button>
          </div>
        ))}
      </div>

      {lastAction ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Your change was saved and recorded in the audit trail.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => undo(lastAction)}
          >
            <Undo2 className="mr-1.5 size-3.5" aria-hidden="true" />
            Undo
          </Button>
        </div>
      ) : null}

      <Dialog
        open={confirming != null}
        onOpenChange={(o) => !o && setConfirming(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirming?.kind === 'reclassify'
                ? 'Move sales tax out of expenses?'
                : 'Exclude sales tax from all spend?'}
            </DialogTitle>
            <DialogDescription className="text-pretty">
              This updates {group.count}{' '}
              {group.count === 1 ? 'payment' : 'payments'} totalling{' '}
              {formatCurrency(group.totalAmount)}. Your original bank records are
              never altered, and this can be undone.
            </DialogDescription>
          </DialogHeader>

          <p className="text-sm text-muted-foreground text-pretty">
            {confirming?.rationale}
          </p>

          {confirming?.kind === 'exclude' ? (
            <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="text-xs text-muted-foreground text-pretty">
                This money did leave your bank account. Excluding it means your
                cash-out total will no longer match your bank statement. Choose
                this only if these payments were recorded twice.
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() => confirming && apply(confirming)}
            >
              {pending
                ? 'Saving…'
                : confirming?.kind === 'reclassify'
                  ? 'Reclassify'
                  : 'Exclude'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
