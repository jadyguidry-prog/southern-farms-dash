'use client'

/**
 * List of saved proposals with their before/after verdict.
 *
 * Every badge here is a LIVE verdict from the shared `getSavedProposalReviews`
 * loader — the same one the detail page, dashboard and advisor use — so no row can
 * show a stale answer that contradicts the page it links to. When the live verdict
 * differs from the one recorded at save time, the row states the movement outright
 * ("was X, now Y").
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { PROPOSAL_TYPE_LABELS } from '@/lib/growth-proposals'
import type { SavedProposalSummary } from '@/app/growth/proposal-types'
import { deleteProposal, setProposalApproved } from '@/app/growth/proposal-store'
import { ClassificationBadge } from '@/components/growth/proposal-decision'
import { Button, buttonVariants } from '@/components/ui/button'

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function SavedProposalsList({ proposals }: { proposals: SavedProposalSummary[] }) {
  if (proposals.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-8 text-center">
        <p className="text-sm text-muted-foreground text-pretty">
          Nothing saved yet. Analyse an investment on the Growth Planner and choose
          &ldquo;Save this proposal&rdquo; to track how its answer changes as your cash moves.
        </p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {proposals.map((p) => (
        <SavedRow key={p.id} p={p} />
      ))}
    </ul>
  )
}

function SavedRow({ p }: { p: SavedProposalSummary }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState(false)

  function onDelete() {
    startTransition(async () => {
      await deleteProposal(p.id)
      router.refresh()
    })
  }

  function onToggleApproved() {
    startTransition(async () => {
      await setProposalApproved(p.id, !p.approvedAt)
      router.refresh()
    })
  }

  return (
    <li className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Link
            href={`/growth/proposals/${p.id}`}
            className="text-base font-semibold text-foreground underline-offset-2 hover:underline"
          >
            {p.name}
          </Link>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {PROPOSAL_TYPE_LABELS[p.proposalType]} · saved {fmtDate(p.createdAt)}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {p.changed ? (
              <>
                <span className="text-xs text-muted-foreground">Was</span>
                <ClassificationBadge classification={p.originalClassification} muted />
                <span className="text-xs text-muted-foreground">→ now</span>
                <ClassificationBadge classification={p.liveClassification} />
              </>
            ) : (
              <ClassificationBadge classification={p.liveClassification} />
            )}
            <span className="text-xs text-muted-foreground">checked against today&apos;s cash</span>
            {p.approvedAt ? (
              <span className="inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                Went ahead
              </span>
            ) : null}
          </div>
          {p.worsened ? (
            <p className="mt-2 text-xs text-amber-700">
              This fits less well than when you saved it — re-open it before committing.
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={`/growth/proposals/${p.id}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Open &amp; re-check
          </Link>
          {confirming ? (
            <>
              <Button variant="destructive" size="sm" onClick={onDelete} disabled={pending}>
                {pending ? 'Removing…' : 'Confirm'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onToggleApproved} disabled={pending}>
                {p.approvedAt ? 'Undo went ahead' : 'Mark as went ahead'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                Remove
              </Button>
            </>
          )}
        </div>
      </div>
    </li>
  )
}
