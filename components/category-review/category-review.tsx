'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  ArrowRight,
  Check,
  X,
  Undo2,
  AlertTriangle,
  Layers,
  ReceiptText,
  HelpCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatCurrency } from '@/lib/data'
import type {
  CategoryReviewData,
  ReviewableMerge,
} from '@/lib/category-review-service'
import {
  approveMerge,
  rejectMerge,
  reclassifyToIncome,
  categorizeTransactions,
  revertBulkAction,
} from '@/app/category-review/actions'

type Busy = string | null

export function CategoryReview({ data }: { data: CategoryReviewData }) {
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<Busy>(null)

  // Confirmation dialog state for an in-flight merge.
  const [confirmMerge, setConfirmMerge] = useState<ReviewableMerge | null>(null)
  const [chosenTarget, setChosenTarget] = useState<string>('')

  // CHECK cluster categorization dialog.
  const [checkCategory, setCheckCategory] = useState('')

  function run(key: string, fn: () => Promise<{ ok: boolean; error?: string; updated?: number }>, okMsg: string) {
    setBusy(key)
    startTransition(async () => {
      const res = await fn()
      setBusy(null)
      if (res.ok) {
        toast.success(okMsg, {
          description:
            typeof res.updated === 'number'
              ? `${res.updated} transaction${res.updated === 1 ? '' : 's'} updated.`
              : undefined,
        })
      } else {
        toast.error('Nothing was changed', { description: res.error })
      }
    })
  }

  const proposals = data.proposals.filter((p) => p.priorStatus !== 'approved')
  const approvedCount = data.proposals.filter((p) => p.priorStatus === 'approved').length

  return (
    <div className="flex flex-col gap-6">
      <Tabs defaultValue="merges">
        <TabsList className="flex w-full flex-wrap">
          <TabsTrigger value="merges" className="gap-2">
            <Layers className="size-4" aria-hidden />
            Category merges
            {proposals.length > 0 && (
              <Badge variant="secondary">{proposals.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="mistyped" className="gap-2">
            <AlertTriangle className="size-4" aria-hidden />
            Type flags
            {data.mistyped.length > 0 && (
              <Badge variant="secondary">{data.mistyped.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="checks" className="gap-2">
            <ReceiptText className="size-4" aria-hidden />
            Checks
          </TabsTrigger>
        </TabsList>

        {/* -------------------------------------------------------------- */}
        {/* Category merge proposals                                       */}
        {/* -------------------------------------------------------------- */}
        <TabsContent value="merges" className="mt-4 flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
            These are stored spending categories that appear to be the same
            bucket spelled differently. Nothing here changes your reports until
            you approve it, and every approval can be undone. Merges only affect
            how categories are grouped for display &mdash; your original
            transaction data is never overwritten.
            {approvedCount > 0 && (
              <span className="mt-1 block text-foreground">
                {approvedCount} merge{approvedCount === 1 ? '' : 's'} already
                approved.
              </span>
            )}
          </p>

          {proposals.length === 0 ? (
            <EmptyState
              icon={<Check className="size-5" aria-hidden />}
              title="No category merges to review"
              body="Every duplicate we could detect has been decided. New ones will appear here if more categories are imported."
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {proposals.map((p) => (
                <li
                  key={p.signature}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {p.fromCategories.map((c) => (
                          <Badge key={c} variant="outline" className="max-w-full truncate">
                            {c}
                          </Badge>
                        ))}
                        <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <Badge className="max-w-full truncate">{p.toCategory}</Badge>
                        {p.requiresChoice && (
                          <Badge variant="secondary" className="gap-1">
                            <HelpCircle className="size-3" aria-hidden />
                            needs your call
                          </Badge>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground text-pretty">
                        {p.reason}
                      </p>
                      <p className="mt-1 text-sm text-foreground">
                        {p.transactionCount} transaction
                        {p.transactionCount === 1 ? '' : 's'} &middot;{' '}
                        {formatCurrency(p.totalAmount)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setChosenTarget(p.toCategory)
                          setConfirmMerge(p)
                        }}
                      >
                        Review &amp; approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending && busy === `reject:${p.signature}`}
                        onClick={() =>
                          run(
                            `reject:${p.signature}`,
                            () =>
                              rejectMerge({
                                fromCategories: p.fromCategories,
                                toCategory: p.toCategory,
                              }),
                            'Suggestion dismissed',
                          )
                        }
                      >
                        <X className="size-4" aria-hidden />
                        <span className="sr-only">Dismiss</span>
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        {/* -------------------------------------------------------------- */}
        {/* Mis-typed income flags                                         */}
        {/* -------------------------------------------------------------- */}
        <TabsContent value="mistyped" className="mt-4 flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
            These transactions carry an income-style category but are stored as
            spending, so they currently count against your outflow. Reclassify
            them to income if they are deposits &mdash; this moves them out of
            the spending totals. You can undo it afterward.
          </p>

          {data.mistyped.length === 0 ? (
            <EmptyState
              icon={<Check className="size-5" aria-hidden />}
              title="No type mismatches found"
              body="No income-style categories are sitting on spending rows."
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {data.mistyped.map((m) => (
                <li
                  key={m.category}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-medium text-foreground">{m.category}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {m.count} row{m.count === 1 ? '' : 's'} &middot;{' '}
                      {formatCurrency(m.amount)} currently counted as spending
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending && busy === `income:${m.category}`}
                    onClick={() =>
                      run(
                        `income:${m.category}`,
                        () => reclassifyToIncome(m.transactionIds),
                        'Reclassified to income',
                      )
                    }
                  >
                    Reclassify to income
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        {/* -------------------------------------------------------------- */}
        {/* CHECK review queue                                             */}
        {/* -------------------------------------------------------------- */}
        <TabsContent value="checks" className="mt-4 flex flex-col gap-4">
          <CheckQueue
            checks={data.checks}
            pending={pending}
            busy={busy}
            category={checkCategory}
            setCategory={setCheckCategory}
            onCategorize={(ids, category, label) =>
              run(
                `check:${label}`,
                () => categorizeTransactions({ transactionIds: ids, category }),
                `Categorized as ${category}`,
              )
            }
          />
        </TabsContent>
      </Tabs>

      {/* Recent actions with undo. */}
      {data.recentActions.length > 0 && (
        <section
          aria-labelledby="recent-actions"
          className="rounded-lg border border-border bg-card p-4"
        >
          <h3 id="recent-actions" className="text-sm font-semibold text-foreground">
            Recent changes
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Every change here is reversible. Undo restores the exact previous
            values.
          </p>
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {data.recentActions.map((a) => (
              <li
                key={a.bulkActionId}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="min-w-0 text-muted-foreground">
                  <span className="text-foreground">{describeAction(a.action)}</span>{' '}
                  &middot; {a.count} row{a.count === 1 ? '' : 's'}
                  {a.sampleFrom && a.sampleTo && (
                    <span className="hidden sm:inline">
                      {' '}
                      &middot; {a.sampleFrom} &rarr; {a.sampleTo}
                    </span>
                  )}
                </span>
                {a.reverted ? (
                  <Badge variant="outline">Undone</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending && busy === `undo:${a.bulkActionId}`}
                    onClick={() =>
                      run(
                        `undo:${a.bulkActionId}`,
                        () => revertBulkAction(a.bulkActionId),
                        'Change undone',
                      )
                    }
                  >
                    <Undo2 className="size-4" aria-hidden />
                    Undo
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Merge confirmation dialog. */}
      <Dialog
        open={confirmMerge !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmMerge(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm category merge</DialogTitle>
            <DialogDescription>
              This regroups {confirmMerge?.transactionCount} transaction
              {confirmMerge?.transactionCount === 1 ? '' : 's'} worth{' '}
              {confirmMerge ? formatCurrency(confirmMerge.totalAmount) : ''} under
              a single category for reporting. Your stored transaction data is
              not overwritten, and you can undo this.
            </DialogDescription>
          </DialogHeader>

          {confirmMerge?.requiresChoice ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-foreground">
                These may not be the same thing. Pick the name to keep, or cancel
                to leave them separate:
              </p>
              <div className="flex flex-col gap-2">
                {confirmMerge.fromCategories.map((c) => (
                  <label
                    key={c}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="merge-target"
                      value={c}
                      checked={chosenTarget === c}
                      onChange={() => setChosenTarget(c)}
                    />
                    {c}
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {confirmMerge?.fromCategories.join(', ')} &rarr;{' '}
              <span className="text-foreground">{confirmMerge?.toCategory}</span>
            </p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmMerge(null)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                if (!confirmMerge) return
                const target = confirmMerge.requiresChoice
                  ? chosenTarget
                  : confirmMerge.toCategory
                const from = confirmMerge.fromCategories.filter((c) => c !== target)
                const merge = confirmMerge
                setConfirmMerge(null)
                run(
                  `approve:${merge.signature}`,
                  () =>
                    approveMerge({
                      fromCategories: from,
                      toCategory: target,
                      reason: merge.reason,
                    }),
                  'Categories merged',
                )
              }}
            >
              Merge categories
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CheckQueue({
  checks,
  pending,
  busy,
  category,
  setCategory,
  onCategorize,
}: {
  checks: CategoryReviewData['checks']
  pending: boolean
  busy: Busy
  category: string
  setCategory: (v: string) => void
  onCategorize: (ids: string[], category: string, label: string) => void
}) {
  const [activeCluster, setActiveCluster] = useState<string | null>(null)

  if (checks.totalChecks === 0) {
    return (
      <EmptyState
        icon={<Check className="size-5" aria-hidden />}
        title="No checks to review"
        body="No transactions are recorded only as a check."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-muted/40 p-4">
        <p className="text-sm leading-relaxed text-foreground text-pretty">
          {formatCurrency(checks.totalAmount)} across {checks.totalChecks}{' '}
          checks names no payee in the bank export &mdash; only a check number.
          No rule
          can guess who was paid, so these need your eyes. The groups below share
          an identical amount, which usually means one recurring payee. Recognize
          a group and you can categorize the whole batch at once.
        </p>
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-muted-foreground">
          <span>{checks.numberedCount} numbered</span>
          {checks.bareCount > 0 && <span>{checks.bareCount} with no number</span>}
          {checks.numberRange && (
            <span>
              #{checks.numberRange.min}&ndash;#{checks.numberRange.max}
            </span>
          )}
          <span>{checks.reviewedCount} already categorized</span>
        </div>
      </div>

      {checks.amountClusters.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repeating amounts &mdash; every check is a distinct amount, so there
          are no batches to categorize together.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {checks.amountClusters.map((c) => {
            const key = `${c.amount}`
            const open = activeCluster === key
            return (
              <li
                key={key}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">
                        {formatCurrency(c.amount)} &times; {c.count}
                      </span>
                      {c.looksRecurring && (
                        <Badge variant="secondary">likely recurring</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {formatCurrency(c.total)} total &middot; {c.firstDate}
                      {c.lastDate && c.lastDate !== c.firstDate
                        ? ` – ${c.lastDate}`
                        : ''}
                      {c.checkNumbers.length > 0 && (
                        <span className="hidden sm:inline">
                          {' '}
                          &middot; #{c.checkNumbers.slice(0, 6).join(', #')}
                          {c.checkNumbers.length > 6 ? '…' : ''}
                        </span>
                      )}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={open ? 'secondary' : 'outline'}
                    onClick={() => {
                      setActiveCluster(open ? null : key)
                      setCategory('')
                    }}
                  >
                    {open ? 'Close' : 'Categorize batch'}
                  </Button>
                </div>

                {open && (
                  <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-end">
                    <div className="flex-1">
                      <label
                        htmlFor={`cat-${key}`}
                        className="text-xs font-medium text-muted-foreground"
                      >
                        Category for these {c.count} checks
                      </label>
                      <Input
                        id={`cat-${key}`}
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        placeholder="e.g. Rent, Payroll, Contract Labor"
                        className="mt-1"
                      />
                    </div>
                    <Button
                      disabled={pending || !category.trim() || busy === `check:${key}`}
                      onClick={() =>
                        onCategorize(c.transactionIds, category.trim(), key)
                      }
                    >
                      Apply to {c.count}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </span>
      <p className="font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground text-pretty">{body}</p>
    </div>
  )
}

function describeAction(action: string): string {
  switch (action) {
    case 'category_merge':
      return 'Merged categories'
    case 'reclassify_type':
      return 'Reclassified to income'
    case 'categorize_checks':
      return 'Categorized checks'
    default:
      return 'Change'
  }
}
