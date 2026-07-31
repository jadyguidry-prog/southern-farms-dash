'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Layers,
  ListChecks,
  Undo2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TransactionDocumentsDialog } from '@/components/documents/transaction-documents-dialog'
import { formatCurrency } from '@/lib/data'
import type {
  CheckResolutionDataset,
  CheckBulkAction,
} from '@/lib/check-resolution-service'
import type { CheckSuggestion, CheckRow } from '@/lib/check-review'
import {
  resolveChecks,
  rejectChecks,
  undoBulkAction,
} from '@/app/check-resolution/actions'

const CONFIDENCE_STYLE: Record<
  CheckSuggestion['confidence'],
  { label: string; className: string }
> = {
  high: { label: 'Strong signal', className: 'bg-primary text-primary-foreground' },
  medium: { label: 'Worth a look', className: 'bg-secondary text-secondary-foreground' },
  low: { label: 'Weak hint', className: 'border border-border text-muted-foreground' },
}

export function CheckResolution({
  data,
  documentCounts = {},
  maxUploadMb = 25,
}: {
  data: CheckResolutionDataset
  /** Attachment count per transaction id, so rows can show a badge. */
  documentCounts?: Record<string, number>
  maxUploadMb?: number
}) {
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)

  // The group currently being named, plus the owner's answers.
  const [active, setActive] = useState<CheckSuggestion | null>(null)
  const [payee, setPayee] = useState('')
  const [category, setCategory] = useState('')
  const [memo, setMemo] = useState('')
  const [purpose, setPurpose] = useState('')
  // Within a group the owner can exclude individual checks that do not belong.
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const approvedIds = useMemo(
    () =>
      new Set(
        data.resolutions
          .filter((r) => r.reviewStatus === 'approved' || r.reviewStatus === 'rejected')
          .map((r) => r.financialTransactionId),
      ),
    [data.resolutions],
  )

  const checkById = useMemo(
    () => new Map(data.checks.map((c) => [c.id, c])),
    [data.checks],
  )

  // Only show groups that still contain unresolved checks, so the queue shrinks
  // as work is done instead of repeating settled answers.
  const openSuggestions = useMemo(
    () =>
      data.suggestions
        .map((s) => ({
          ...s,
          transactionIds: s.transactionIds.filter((id) => !approvedIds.has(id)),
        }))
        .filter((s) => s.transactionIds.length > 0)
        .map((s) => ({
          ...s,
          count: s.transactionIds.length,
          total: s.transactionIds.reduce(
            (sum, id) => sum + (checkById.get(id)?.amount ?? 0),
            0,
          ),
        })),
    [data.suggestions, approvedIds, checkById],
  )

  // Checks not covered by any suggestion — the long tail that must still be
  // reachable, or the backlog could never reach zero.
  const ungroupedChecks = useMemo(() => {
    const grouped = new Set(openSuggestions.flatMap((s) => s.transactionIds))
    return data.checks
      .filter((c) => !grouped.has(c.id) && !approvedIds.has(c.id))
      .sort((a, b) => b.amount - a.amount)
  }, [data.checks, openSuggestions, approvedIds])

  const selectedIds = useMemo(
    () => (active ? active.transactionIds.filter((id) => !excluded.has(id)) : []),
    [active, excluded],
  )
  const selectedTotal = useMemo(
    () => selectedIds.reduce((s, id) => s + (checkById.get(id)?.amount ?? 0), 0),
    [selectedIds, checkById],
  )

  function openGroup(s: CheckSuggestion) {
    setActive(s)
    setExcluded(new Set())
    setPayee('')
    setCategory('')
    setMemo('')
    setPurpose('')
  }

  function run(
    key: string,
    fn: () => Promise<{ ok: boolean; error?: string; updated?: number }>,
    okMsg: string,
  ) {
    setBusy(key)
    startTransition(async () => {
      const res = await fn()
      setBusy(null)
      if (res.ok) {
        toast.success(okMsg, {
          description:
            typeof res.updated === 'number'
              ? `${res.updated} check${res.updated === 1 ? '' : 's'} recorded.`
              : undefined,
        })
        if (res.error) toast.warning(res.error)
        setActive(null)
      } else {
        toast.error('Nothing was saved', { description: res.error })
      }
    })
  }

  const p = data.progress

  return (
    <div className="flex flex-col gap-6">
      {data.overlayUnavailable ? (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-medium">Resolutions cannot be saved yet</p>
            <p className="mt-1 text-muted-foreground text-pretty">
              The check resolution tables are not available, so this screen is
              read-only. Your bank records are unaffected.
            </p>
          </div>
        </div>
      ) : null}

      {/* Progress leads with DOLLARS, not counts: resolving five large checks
          moves gross profit far more than fifty small ones. */}
      <section
        aria-labelledby="check-progress"
        className="rounded-lg border border-border p-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="check-progress" className="text-sm font-semibold">
            Resolution progress
          </h2>
          <p className="text-xs text-muted-foreground">
            {p.resolvedCount} of {p.totalChecks} checks
          </p>
        </div>
        <Progress
          value={p.resolvedPctOfAmount}
          className="mt-3"
          aria-label="Share of check dollars resolved"
        />
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Resolved</dt>
            <dd className="text-sm font-semibold tabular-nums">
              {formatCurrency(p.resolvedAmount)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Still unknown</dt>
            <dd className="text-sm font-semibold tabular-nums">
              {formatCurrency(p.pendingAmount)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Found to be COGS</dt>
            <dd className="text-sm font-semibold tabular-nums">
              {formatCurrency(p.cogsAmount)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Share of dollars done</dt>
            <dd className="text-sm font-semibold tabular-nums">
              {p.resolvedPctOfAmount.toFixed(1)}%
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground text-pretty">
          Progress is measured in dollars rather than checks, because a handful of
          large checks affect gross profit far more than many small ones. Every
          resolution is saved separately from your bank records and can be undone.
        </p>
      </section>

      <Tabs defaultValue="groups">
        <TabsList>
          <TabsTrigger value="groups" className="gap-2">
            <Layers className="size-4" />
            Suggested groups
            <Badge variant="secondary">{openSuggestions.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="remaining" className="gap-2">
            <ListChecks className="size-4" />
            Individual checks
            <Badge variant="secondary">{ungroupedChecks.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-2">
            <Undo2 className="size-4" />
            History
            <Badge variant="secondary">{data.recentActions.length}</Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="groups" className="mt-4">
          {openSuggestions.length === 0 ? (
            <EmptyState
              title="No grouped checks left"
              body="Every repeating-amount and sequential group has been reviewed. Any checks still outstanding are on the Individual checks tab."
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {openSuggestions.map((s) => {
                const conf = CONFIDENCE_STYLE[s.confidence]
                const isOpen = expanded.has(s.key)
                return (
                  <li
                    key={s.key}
                    className="rounded-lg border border-border p-4"
                  >
                    {/*
                      Stacks on a phone and only splits into two columns from `sm`
                      up. Side-by-side at 390px squeezed the reasoning into a
                      ~150px column, and that reasoning is what the owner needs to
                      read before naming a payee — it can't be the part that gets
                      crushed. The amount and action sit full width underneath.
                    */}
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-pretty">
                            {s.label}
                          </h3>
                          <Badge className={conf.className}>{conf.label}</Badge>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground text-pretty">
                          {s.rationale}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {s.firstDate} to {s.lastDate}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center justify-between gap-3 sm:flex-col sm:items-end">
                        <p className="text-base font-semibold tabular-nums">
                          {formatCurrency(s.total)}
                        </p>
                        <Button size="sm" onClick={() => openGroup(s)}>
                          Name this group
                        </Button>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev)
                          if (next.has(s.key)) next.delete(s.key)
                          else next.add(s.key)
                          return next
                        })
                      }
                      className="mt-3 flex items-center gap-1 text-xs text-muted-foreground underline"
                      aria-expanded={isOpen}
                    >
                      <ChevronDown
                        className={`size-3 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                      />
                      {isOpen ? 'Hide' : 'Show'} the {s.count} checks
                    </button>
                    {isOpen ? (
                      <CheckList
                        ids={s.transactionIds}
                        checkById={checkById}
                        className="mt-2"
                      />
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="remaining" className="mt-4">
          {ungroupedChecks.length === 0 ? (
            <EmptyState
              title="No individual checks outstanding"
              body="Every check outside a suggested group has been resolved."
            />
          ) : (
            <div className="rounded-lg border border-border">
              <p className="border-b border-border p-3 text-xs text-muted-foreground text-pretty">
                These checks share no amount or numbering pattern with others, so
                they need naming one at a time. Largest first — those move gross
                profit most.
              </p>
              <ul className="divide-y divide-border">
                {ungroupedChecks.slice(0, 60).map((c) => (
                  <li
                    key={c.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {c.checkNumber ? `Check ${c.checkNumber}` : 'Check (no number)'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {c.transactionDate}
                        {c.accountName ? ` · ${c.accountName}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold tabular-nums">
                        {formatCurrency(c.amount)}
                      </span>
                      <TransactionDocumentsDialog
                        transactionId={c.id}
                        title={
                          c.checkNumber
                            ? `Check ${c.checkNumber} · ${formatCurrency(c.amount)}`
                            : `Check · ${formatCurrency(c.amount)}`
                        }
                        subtitle={
                          c.checkNumber
                            ? `Look up check ${c.checkNumber} in your bank portal, then attach the scan so the payee stays on file.`
                            : 'This check has no number, so identify it by date and amount in your bank portal, then attach the scan.'
                        }
                        count={documentCounts[c.id] ?? 0}
                        maxUploadMb={maxUploadMb}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          openGroup({
                            key: `single:${c.id}`,
                            kind: 'amount-cluster',
                            label: c.checkNumber
                              ? `Check ${c.checkNumber}`
                              : 'Check (no number)',
                            rationale:
                              'A single check with no matching amount or sequence. Naming it only affects this one row.',
                            confidence: 'low',
                            transactionIds: [c.id],
                            total: c.amount,
                            count: 1,
                            firstDate: c.transactionDate,
                            lastDate: c.transactionDate,
                            cadence: null,
                          })
                        }
                      >
                        Name
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {ungroupedChecks.length > 60 ? (
                <p className="border-t border-border p-3 text-xs text-muted-foreground">
                  Showing the 60 largest of {ungroupedChecks.length}. Resolve these
                  and the next batch appears.
                </p>
              ) : null}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          {data.recentActions.length === 0 ? (
            <EmptyState
              title="Nothing resolved yet"
              body="Once you name a group it appears here, and can be undone with one click."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {data.recentActions.map((a) => (
                <HistoryRow
                  key={a.bulkActionId}
                  action={a}
                  busy={busy === `undo:${a.bulkActionId}`}
                  disabled={pending}
                  onUndo={() =>
                    run(
                      `undo:${a.bulkActionId}`,
                      () => undoBulkAction(a.bulkActionId),
                      'Resolution undone',
                    )
                  }
                />
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      {/* Naming dialog. Shows the exact dollar impact before saving, because the
          owner is committing to a number that will feed gross profit. */}
      <Dialog open={Boolean(active)} onOpenChange={(o) => !o && setActive(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-pretty">
              {active?.label ?? 'Name this group'}
            </DialogTitle>
            <DialogDescription className="text-pretty">
              Record who was paid. This is saved as your answer alongside the bank
              record — the original CHECK line is never altered.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payee">Paid to</Label>
              <Input
                id="payee"
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
                placeholder="Supplier or person's name"
                list="payee-options"
                autoComplete="off"
              />
              <datalist id="payee-options">
                {data.payeeOptions.map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="category">Category</Label>
              <Input
                id="category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. Meat / COGS"
                list="category-options"
                autoComplete="off"
              />
              <datalist id="category-options">
                {data.categoryOptions.map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground text-pretty">
                Use one of your existing categories so reports stay consistent.
                Anything containing &quot;COGS&quot; counts toward cost of goods.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="purpose">
                What was it for{' '}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="e.g. weekly beef delivery"
              />
            </div>

            {active && active.transactionIds.length > 1 ? (
              <div className="rounded-md border border-border p-3">
                <p className="text-xs font-medium">
                  Applying to {selectedIds.length} of {active.transactionIds.length}{' '}
                  checks
                </p>
                <p className="mt-1 text-xs text-muted-foreground text-pretty">
                  Untick any that do not belong to this payee.
                </p>
                <ul className="mt-2 flex max-h-40 flex-col gap-1.5 overflow-y-auto">
                  {active.transactionIds.map((id) => {
                    const c = checkById.get(id)
                    if (!c) return null
                    return (
                      <li key={id} className="flex items-center gap-2">
                        <Checkbox
                          id={`inc-${id}`}
                          checked={!excluded.has(id)}
                          onCheckedChange={(v) =>
                            setExcluded((prev) => {
                              const next = new Set(prev)
                              if (v) next.delete(id)
                              else next.add(id)
                              return next
                            })
                          }
                        />
                        <label
                          htmlFor={`inc-${id}`}
                          className="flex flex-1 justify-between gap-2 text-xs"
                        >
                          <span>
                            {c.checkNumber ? `#${c.checkNumber}` : 'no number'} ·{' '}
                            {c.transactionDate}
                          </span>
                          <span className="tabular-nums">
                            {formatCurrency(c.amount)}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}

            {/* Impact preview — the number that will move if this is saved. */}
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">
                Effect of saving this
              </p>
              <p className="mt-1 text-sm text-pretty">
                <span className="font-semibold tabular-nums">
                  {formatCurrency(selectedTotal)}
                </span>{' '}
                moves out of unexplained checks
                {category.trim() ? (
                  <>
                    {' '}
                    and into{' '}
                    <span className="font-medium">{category.trim()}</span>
                  </>
                ) : null}
                . Unexplained checks would fall from{' '}
                <span className="tabular-nums">
                  {formatCurrency(p.pendingAmount)}
                </span>{' '}
                to{' '}
                <span className="font-semibold tabular-nums">
                  {formatCurrency(Math.max(0, p.pendingAmount - selectedTotal))}
                </span>
                .
              </p>
            </div>
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              onClick={() =>
                active &&
                run(
                  `reject:${active.key}`,
                  () => rejectChecks(selectedIds, 'Reviewed — not cost of goods'),
                  'Marked as reviewed',
                )
              }
              disabled={pending || selectedIds.length === 0 || data.overlayUnavailable}
              className="gap-2"
            >
              <X className="size-4" />
              Not supplier spend
            </Button>
            <Button
              onClick={() =>
                active &&
                run(
                  `resolve:${active.key}`,
                  () =>
                    resolveChecks({
                      transactionIds: selectedIds,
                      payee,
                      category,
                      businessPurpose: purpose,
                      memo,
                      source: active.kind,
                      confidence: active.confidence,
                    }),
                  'Checks resolved',
                )
              }
              disabled={
                pending ||
                selectedIds.length === 0 ||
                !payee.trim() ||
                !category.trim() ||
                data.overlayUnavailable
              }
              className="gap-2"
            >
              <Check className="size-4" />
              Save for {selectedIds.length} check
              {selectedIds.length === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CheckList({
  ids,
  checkById,
  className = '',
}: {
  ids: string[]
  checkById: Map<string, CheckRow>
  className?: string
}) {
  return (
    <ul className={`flex flex-col gap-1 rounded-md border border-border p-2 ${className}`}>
      {ids.map((id) => {
        const c = checkById.get(id)
        if (!c) return null
        return (
          <li key={id} className="flex justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              {c.checkNumber ? `#${c.checkNumber}` : 'no number'} · {c.transactionDate}
            </span>
            <span className="tabular-nums">{formatCurrency(c.amount)}</span>
          </li>
        )
      })}
    </ul>
  )
}

function HistoryRow({
  action,
  busy,
  disabled,
  onUndo,
}: {
  action: CheckBulkAction
  busy: boolean
  disabled: boolean
  onUndo: () => void
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-pretty">
          {action.payee
            ? `${action.payee}${action.category ? ` · ${action.category}` : ''}`
            : (action.reason ?? 'Reviewed')}
        </p>
        <p className="text-xs text-muted-foreground">
          {action.rowCount} check{action.rowCount === 1 ? '' : 's'}
          {action.amount > 0 ? ` · ${formatCurrency(action.amount)}` : ''}
          {action.createdAt ? ` · ${action.createdAt.slice(0, 10)}` : ''}
          {action.actorEmail ? ` · ${action.actorEmail}` : ''}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onUndo}
        disabled={disabled || busy}
        className="gap-2"
      >
        <Undo2 className="size-4" />
        {busy ? 'Undoing…' : 'Undo'}
      </Button>
    </li>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground text-pretty">{body}</p>
    </div>
  )
}
