'use client'

/**
 * List of saved proposals with their before/after verdict.
 *
 * The figures shown are the LAST CHECKED snapshot (labelled with its date), not a
 * live re-run — re-running every row on every list render would be arbitrarily
 * expensive. Opening a proposal re-checks it live. When the current verdict differs
 * from the original, the row makes that movement explicit ("was X, now Y").
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { PROPOSAL_TYPE_LABELS } from '@/lib/growth-proposals'
import type { SavedProposalSummary } from '@/app/growth/proposal-types'
import { deleteProposal } from '@/app/growth/proposal-store'
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
                <ClassificationBadge classification={p.original.classification} muted />
                <span className="text-xs text-muted-foreground">→ now</span>
                <ClassificationBadge classification={p.current.classification} />
              </>
            ) : (
              <ClassificationBadge classification={p.current.classification} />
            )}
            <span className="text-xs text-muted-foreground">
              last checked {fmtDate(p.current.createdAt)}
            </span>
          </div>
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
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
              Remove
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}
