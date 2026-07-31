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
  DecidedMerge,
  MistypedFlag,
} from '@/lib/category-review-service'
import type { ReclassifyVerdict } from '@/lib/reclassify-evidence'
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

  // Confirmation dialog for a type reclassification, with impact preview.
  const [confirmReclassify, setConfirmReclassify] = useState<MistypedFlag | null>(
    null,
  )

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

  // `data.proposals` is already only the undecided queue. Everything the owner
  // has acted on lives in `data.decisions`, grouped here for the status board.
  const proposals = data.proposals
  const byStatus = {
    approved: data.decisions.filter((d) => d.status === 'approved'),
    rejected: data.decisions.filter((d) => d.status === 'rejected'),
    undone: data.decisions.filter((d) => d.status === 'undone'),
    pending: data.decisions.filter((d) => d.status === 'pending'),
  }

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
            bucket spelled differently. Until you approve one, each label is
            reported separately &mdash; a pending suggestion has no effect on any
            total. Approving only changes how categories are grouped for
            display; your original transaction data is never overwritten, and
            undoing an approval restores the ungrouped view immediately.
          </p>

          <MergeStatusBoard
            pendingCount={proposals.length + byStatus.pending.length}
            byStatus={byStatus}
            pending={pending}
            busy={busy}
            onUndo={(id) =>
              run(`undo:${id}`, () => revertBulkAction(id), 'Merge undone')
            }
            onReapprove={(d) =>
              run(
                `approve:${d.signature}`,
                () =>
                  approveMerge({
                    fromCategories: d.fromCategories,
                    toCategory: d.toCategory,
                  }),
                'Categories merged',
              )
            }
          />

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
            These transactions carry an income-style category but were imported
            as spending. A shared label is not proof of anything, so each group
            below is judged on its own rows &mdash; direction, repeating amounts
            and timing. Where the evidence points to a recurring fee rather than
            income, reclassifying is blocked, because calling a fee &ldquo;income&rdquo;
            would add revenue that never arrived and erase a real cost at the
            same time. Nothing is reclassified automatically.
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
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-foreground">{m.category}</p>
                      <VerdictBadge verdict={m.evidence.verdict} />
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {m.count} row{m.count === 1 ? '' : 's'} &middot;{' '}
                      {formatCurrency(m.amount)} currently counted as spending
                      {m.months.length > 0 && (
                        <> &middot; {m.months.length} month
                          {m.months.length === 1 ? '' : 's'} affected</>
                      )}
                    </p>
                    {/* The single most important reason, visible without opening
                        the dialog, so the safe choice needs no extra click. */}
                    {m.evidence.reasons.length > 0 && (
                      <p className="mt-1 text-sm text-foreground text-pretty">
                        {m.evidence.verdict === 'likely_recurring_fee'
                          ? m.evidence.reasons[1] ?? m.evidence.reasons[0]
                          : m.evidence.reasons[0]}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setConfirmReclassify(m)}
                  >
                    {m.evidence.blocksReclassification
                      ? 'See the evidence'
                      : 'Review reclassification'}
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

      {/* Reclassification confirmation, with before-and-after cash impact. */}
      <Dialog
        open={confirmReclassify !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmReclassify(null)
        }}
      >
        <DialogContent className="max-h-[90svh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {confirmReclassify?.evidence.blocksReclassification
                ? `What the ${confirmReclassify?.category} rows actually show`
                : `Reclassify ${confirmReclassify?.category} to income`}
            </DialogTitle>
            <DialogDescription>
              {confirmReclassify?.evidence.blocksReclassification
                ? 'These rows were tested against their own history before anything was offered. Here is what they show.'
                : 'This changes the transaction type from expense to income. The original imported type is kept in history, so this can be undone.'}
            </DialogDescription>
          </DialogHeader>

          {confirmReclassify && (
            <div className="flex flex-col gap-4 text-sm">
              {/* Evidence first: the reasoning, before any numbers or buttons. */}
              <section
                aria-label="Evidence"
                className={
                  confirmReclassify.evidence.blocksReclassification
                    ? 'rounded-md border border-destructive/40 bg-destructive/5 p-3'
                    : 'rounded-md border border-border bg-muted/40 p-3'
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <VerdictBadge verdict={confirmReclassify.evidence.verdict} />
                  <span className="text-xs text-muted-foreground">
                    {confirmReclassify.evidence.rowCount} row
                    {confirmReclassify.evidence.rowCount === 1 ? '' : 's'} across{' '}
                    {confirmReclassify.evidence.monthCount} month
                    {confirmReclassify.evidence.monthCount === 1 ? '' : 's'} &middot; avg{' '}
                    {formatCurrency(confirmReclassify.evidence.averageAmount)}
                  </span>
                </div>
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
                  {confirmReclassify.evidence.reasons.map((r) => (
                    <li key={r} className="text-foreground text-pretty">
                      {r}
                    </li>
                  ))}
                </ul>
                {confirmReclassify.evidence.recurringAmounts.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Amounts that repeat across months
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {confirmReclassify.evidence.recurringAmounts.slice(0, 6).map((r) => (
                        <Badge key={r.amount} variant="outline" className="tabular-nums">
                          {formatCurrency(r.amount)} &times; {r.monthCount} mo
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <dl className="grid grid-cols-2 gap-3">
                <Stat
                  label="Affected transactions"
                  value={String(confirmReclassify.count)}
                />
                <Stat
                  label="Total amount"
                  value={formatCurrency(confirmReclassify.amount)}
                />
              </dl>

              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Affected months ({confirmReclassify.months.length})
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {confirmReclassify.months.map((mo) => (
                    <Badge key={mo} variant="outline">
                      {mo}
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="rounded-md border border-border">
                <table className="w-full text-left">
                  <caption className="sr-only">
                    Cash-in and cash-out totals before and after this change
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th scope="col" className="p-2 font-medium">
                        Total
                      </th>
                      <th scope="col" className="p-2 text-right font-medium">
                        Now
                      </th>
                      <th scope="col" className="p-2 text-right font-medium">
                        After
                      </th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    <tr className="border-b border-border">
                      <th scope="row" className="p-2 font-normal text-muted-foreground">
                        Cash in
                      </th>
                      <td className="p-2 text-right text-foreground">
                        {formatCurrency(data.currentCashIn)}
                      </td>
                      <td className="p-2 text-right font-medium text-foreground">
                        {formatCurrency(confirmReclassify.resultingCashIn)}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" className="p-2 font-normal text-muted-foreground">
                        Cash out
                      </th>
                      <td className="p-2 text-right text-foreground">
                        {formatCurrency(data.currentCashOut)}
                      </td>
                      <td className="p-2 text-right font-medium text-foreground">
                        {formatCurrency(confirmReclassify.resultingCashOut)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
                {confirmReclassify.evidence.blocksReclassification ? (
                  <>
                    This is what reclassifying <em>would</em> do, shown so the cost
                    of the wrong choice is visible. It would add{' '}
                    {formatCurrency(confirmReclassify.amount)} of revenue that never
                    arrived and remove the same amount of real cost, across{' '}
                    {confirmReclassify.months.length} month
                    {confirmReclassify.months.length === 1 ? '' : 's'}. The button is
                    disabled for that reason.
                  </>
                ) : (
                  <>
                    {formatCurrency(confirmReclassify.amount)} moves out of cash-out
                    and expense-category totals and into cash-in. The dashboard,
                    cash-flow reports and Advisor insights recalculate for all{' '}
                    {confirmReclassify.months.length} affected month
                    {confirmReclassify.months.length === 1 ? '' : 's'}.
                  </>
                )}
              </p>

              {/* The way forward. Blocking alone leaves the wrong label in place;
                  the fee still sits under an income-style category. This offers
                  the correction the evidence actually supports. */}
              {confirmReclassify.evidence.blocksReclassification &&
                confirmReclassify.suggestedExpenseCategory && (
                  <section
                    aria-label="Suggested correction"
                    className="rounded-md border border-border bg-muted/40 p-3"
                  >
                    <p className="text-sm font-medium text-foreground">
                      What to do instead
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
                      These rows are spending, so the type is already right — only
                      the category is wrong. Filing them under{' '}
                      <strong className="font-medium text-foreground">
                        {confirmReclassify.suggestedExpenseCategory}
                      </strong>{' '}
                      keeps them as the cost they are and stops them being offered
                      as income again. Cash-in and cash-out totals do not move.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      disabled={pending}
                      onClick={() => {
                        const flag = confirmReclassify
                        const category = flag.suggestedExpenseCategory
                        if (!category) return
                        setConfirmReclassify(null)
                        run(
                          `recategorize:${flag.category}`,
                          () =>
                            categorizeTransactions({
                              transactionIds: flag.transactionIds,
                              category,
                              source: 'mistyped_fee',
                            }),
                          `Recategorized to ${category}`,
                        )
                      }}
                    >
                      Recategorize {confirmReclassify.count} to{' '}
                      {confirmReclassify.suggestedExpenseCategory}
                    </Button>
                  </section>
                )}
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setConfirmReclassify(null)}>
              {confirmReclassify?.evidence.blocksReclassification ? 'Close' : 'Cancel'}
            </Button>
            {confirmReclassify?.evidence.blocksReclassification ? (
              // No override control here on purpose. Overriding is possible, but
              // it belongs behind a deliberate step rather than one click away
              // from the evidence that says not to.
              <Button variant="outline" disabled aria-disabled="true">
                Reclassifying is blocked
              </Button>
            ) : (
              <Button
                disabled={pending}
                onClick={() => {
                  if (!confirmReclassify) return
                  const flag = confirmReclassify
                  setConfirmReclassify(null)
                  run(
                    `income:${flag.category}`,
                    () => reclassifyToIncome(flag.transactionIds),
                    'Reclassified to income',
                  )
                }}
              >
                Reclassify {confirmReclassify?.count} to income
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

/**
 * The four-state board for merge decisions. Makes the reporting consequence of
 * each state explicit, because only "Approved" changes any number on screen.
 */
function MergeStatusBoard({
  pendingCount,
  byStatus,
  pending,
  busy,
  onUndo,
  onReapprove,
}: {
  pendingCount: number
  byStatus: Record<'pending' | 'approved' | 'rejected' | 'undone', DecidedMerge[]>
  pending: boolean
  busy: Busy
  onUndo: (bulkActionId: string) => void
  onReapprove: (d: DecidedMerge) => void
}) {
  const groups = [
    {
      key: 'pending' as const,
      label: 'Pending',
      count: pendingCount,
      note: 'Not affecting any report.',
      items: [] as DecidedMerge[],
    },
    {
      key: 'approved' as const,
      label: 'Approved',
      count: byStatus.approved.length,
      note: 'Grouped for display only.',
      items: byStatus.approved,
    },
    {
      key: 'rejected' as const,
      label: 'Rejected',
      count: byStatus.rejected.length,
      note: 'Declined; kept separate.',
      items: byStatus.rejected,
    },
    {
      key: 'undone' as const,
      label: 'Undone',
      count: byStatus.undone.length,
      note: 'Grouping removed again.',
      items: byStatus.undone,
    },
  ]

  return (
    <section
      aria-labelledby="merge-status"
      className="rounded-lg border border-border bg-card p-4"
    >
      <h3 id="merge-status" className="text-sm font-semibold text-foreground">
        Merge status
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {groups.map((g) => (
          <div key={g.key} className="rounded-md border border-border p-3">
            <dt className="text-xs font-medium text-muted-foreground">{g.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
              {g.count}
            </dd>
            <p className="mt-1 text-xs text-muted-foreground text-pretty">{g.note}</p>
          </div>
        ))}
      </dl>

      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <div key={g.key} className="mt-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {g.label}
            </h4>
            <ul className="mt-2 flex flex-col divide-y divide-border">
              {g.items.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0 text-muted-foreground">
                    <span className="text-foreground">
                      {d.fromCategories.join(', ')}
                    </span>{' '}
                    &rarr; <span className="text-foreground">{d.toCategory}</span>
                    {d.transactionCount > 0 && (
                      <span className="hidden sm:inline">
                        {' '}
                        &middot; {d.transactionCount} row
                        {d.transactionCount === 1 ? '' : 's'} &middot;{' '}
                        {formatCurrency(d.totalAmount)}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0">
                    {g.key === 'approved' && d.bulkActionId ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending && busy === `undo:${d.bulkActionId}`}
                        onClick={() => onUndo(d.bulkActionId as string)}
                      >
                        <Undo2 className="size-4" aria-hidden />
                        Undo
                      </Button>
                    ) : g.key === 'undone' || g.key === 'rejected' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending && busy === `approve:${d.signature}`}
                        onClick={() => onReapprove(d)}
                      >
                        Group again
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  )
}

/**
 * States what the rows were judged to be. Wording is deliberately plain — the
 * owner should be able to tell at a glance whether a group is safe to move,
 * without reading the underlying reasons.
 */
function VerdictBadge({ verdict }: { verdict: ReclassifyVerdict }) {
  const map: Record<ReclassifyVerdict, { label: string; className: string }> = {
    likely_recurring_fee: {
      label: 'looks like a recurring fee',
      className: 'bg-destructive/10 text-destructive border-destructive/30',
    },
    unclear: {
      label: 'needs a human look',
      className: 'bg-muted text-muted-foreground border-border',
    },
    likely_income: {
      label: 'consistent with income',
      className: 'bg-primary/10 text-primary border-primary/30',
    },
  }
  const conf = map[verdict]
  return (
    <Badge variant="outline" className={conf.className}>
      {conf.label}
    </Badge>
  )
}

/** One labelled figure inside the reclassification impact preview. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
        {value}
      </dd>
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
