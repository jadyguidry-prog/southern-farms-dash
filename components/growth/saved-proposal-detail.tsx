'use client'

/**
 * A saved proposal, opened.
 *
 * The verdict shown is a LIVE re-run against today's cash (passed in as
 * `detail.current`), so it is never stale. Above it sits the before/after story:
 * what the proposal said when first saved vs. what it says now. Below, the full
 * decision, then the history of every recorded change.
 *
 * "Re-check now" only records a new history row when the verdict actually moved —
 * see `recheckProposal`. So the history is a log of real changes, not page views.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { PROPOSAL_TYPE_LABELS } from '@/lib/growth-proposals'
import type { SavedProposalDetail } from '@/app/growth/proposal-types'
import { recheckProposal, deleteProposal } from '@/app/growth/proposal-store'
import { ProposalDecisionView, ClassificationBadge } from '@/components/growth/proposal-decision'
import { Button } from '@/components/ui/button'

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function SavedProposalDetailView({ detail }: { detail: SavedProposalDetail }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState<string | null>(null)

  const currentClassification = detail.current.classification
  const changedSinceSaved = detail.original.classification !== currentClassification

  function onRecheck() {
    setNote(null)
    startTransition(async () => {
      const res = await recheckProposal(detail.id)
      if (!res.ok) setNote(res.error)
      else setNote(res.changed ? 'The verdict moved — recorded a new checkpoint.' : 'Re-checked: no change since the last checkpoint.')
      router.refresh()
    })
  }

  function onDelete() {
    startTransition(async () => {
      await deleteProposal(detail.id)
      router.push('/growth/proposals')
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Before / after */}
      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">When you saved it ({fmtDate(detail.original.createdAt)}):</span>
          <ClassificationBadge classification={detail.original.classification} muted />
          <span aria-hidden="true" className="text-muted-foreground">→</span>
          <span className="text-sm text-muted-foreground">Right now:</span>
          <ClassificationBadge classification={currentClassification} />
        </div>
        <p className="mt-2 text-sm leading-relaxed text-foreground text-pretty">
          {changedSinceSaved
            ? `This has moved from "${detail.original.classification}" to "${currentClassification}" as your cash changed. The answer below is recomputed against today's numbers.`
            : `Still "${currentClassification}" as when you saved it. The answer below is recomputed against today's numbers, not the saved copy.`}
        </p>
      </section>

      {/* Live decision */}
      <ProposalDecisionView
        decision={detail.current}
        modeLabel={detail.currentModeLabel}
        confidencePct={detail.currentConfidencePct}
      />

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button type="button" onClick={onRecheck} disabled={pending}>
          {pending ? 'Working…' : 'Re-check now'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDelete} disabled={pending}>
          Remove
        </Button>
        {note ? <span className="text-sm text-muted-foreground">{note}</span> : null}
      </div>

      {/* History */}
      {detail.history.length > 1 ? (
        <section aria-labelledby="history-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <h3 id="history-heading" className="text-sm font-semibold text-foreground">
            How the answer has changed
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
            Each row is a point where the verdict actually moved — not every time you looked.
          </p>
          <ol className="mt-3 flex flex-col gap-2">
            {detail.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-xs tabular-nums text-muted-foreground">{fmtDate(h.createdAt)}</span>
                <ClassificationBadge classification={h.classification} />
                {h.lowestProjectedCash != null ? (
                  <span className="text-xs text-muted-foreground">
                    low point {`$${Math.round(h.lowestProjectedCash).toLocaleString('en-US')}`}
                    {h.lowestMonthKey ? ` (${h.lowestMonthKey})` : ''}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div>
        <Link href="/growth/proposals" className="text-sm font-medium text-primary underline">
          ← All saved proposals
        </Link>
      </div>

      <p className="text-xs text-muted-foreground">
        {PROPOSAL_TYPE_LABELS[detail.proposalType]} · saved {fmtDate(detail.createdAt)}
      </p>
    </div>
  )
}
