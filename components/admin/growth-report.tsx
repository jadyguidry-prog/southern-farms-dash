// Growth-commitment reporting card for the Admin surface (this app's Reporting page).
//
// Reads the SAME `getGrowthPlannerSnapshot` and `getSavedProposalReviews` the
// dashboard card and the AI Advisor read, so the recommended commitment and the
// per-proposal verdicts cannot differ between the three surfaces.
//
// On "forecast vs actual": this reports the FORECAST only. Matching an approved
// proposal to real transactions is not implemented, so actual spend is labelled
// "not yet tracked" rather than shown as $0 — a literal zero here would read as
// "this commitment cost nothing", which is the opposite of the truth.

import type { GrowthPlannerSnapshot } from '@/lib/growth-planner-service'
import type { ProposalReview } from '@/lib/growth-proposal-review'
import { PROPOSAL_TYPE_LABELS } from '@/lib/growth-proposals'
import { formatCurrency } from '@/lib/data'

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function GrowthReport({
  snapshot,
  reviews,
}: {
  snapshot: GrowthPlannerSnapshot
  reviews: ProposalReview[]
}) {
  // Nothing measurable and nothing saved means there is no report to render, so
  // show no empty scaffolding at all.
  if (!snapshot.hasData && reviews.length === 0) return null

  const approved = reviews.filter((r) => r.approvedAt != null)
  const considered = reviews.filter((r) => r.approvedAt == null)
  const changed = reviews.filter((r) => r.changed)

  // Committed forecast: what the owner has said yes to. Recurring and one-time are
  // kept separate because adding them produces a number that means nothing.
  const committedRecurring = approved.reduce(
    (sum, r) => sum + r.live.monthlyCost,
    0,
  )
  const committedOneTime = approved.reduce((sum, r) => sum + r.live.oneTimeCost, 0)

  return (
    <section
      aria-labelledby="growth-report"
      className="rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="growth-report" className="text-sm font-medium">
          Growth Commitments
        </h2>
        {snapshot.hasData ? (
          <p className="text-xs text-muted-foreground">
            {formatCurrency(snapshot.maxRecurring)}/mo recommended on{' '}
            {snapshot.activeMode.label}
          </p>
        ) : null}
      </div>

      {/* Capacity. The headline is the stressed figure; naming the stress on the
          same line prevents this from looking like it contradicts the higher
          ceiling shown on the planner page. */}
      {snapshot.hasData ? (
        <p className="mt-2 text-pretty text-xs text-muted-foreground">
          {snapshot.maxRecurring > 0
            ? `Room for about ${formatCurrency(
                snapshot.maxRecurring,
              )} a month in new recurring commitments, or ${formatCurrency(
                snapshot.maxOneTime,
              )} one-time — amounts that hold even if sales fell ${
                snapshot.activeMode.headlineStressSalesDeclinePct
              }%. On the expected path with no downturn the limits would tolerate up to ${formatCurrency(
                snapshot.edgeRecurring,
              )} a month, which is a ceiling and not a recommendation.`
            : snapshot.edgeRecurring > 0
              ? `No new recurring commitment survives a ${
                  snapshot.activeMode.headlineStressSalesDeclinePct
                }% sales drop. If sales held exactly as expected the limits would tolerate about ${formatCurrency(
                  snapshot.edgeRecurring,
                )} a month, but that is not recommended.`
              : 'Current cash and obligations leave no room for new recurring commitments.'}
        </p>
      ) : (
        <p className="mt-2 text-pretty text-xs text-muted-foreground">
          Commitment capacity is not yet measurable — it needs imported bank
          transactions and revenue history.
        </p>
      )}

      {/* Committed forecast vs actual. */}
      {approved.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs font-medium">
            Committed ({approved.length}
            {approved.length === 1 ? ' proposal' : ' proposals'})
          </h3>
          <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Forecast recurring:</dt>
              <dd className="font-medium">{formatCurrency(committedRecurring)}/mo</dd>
            </div>
            {committedOneTime > 0 ? (
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">Forecast one-time:</dt>
                <dd className="font-medium">{formatCurrency(committedOneTime)}</dd>
              </div>
            ) : null}
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Actual spend:</dt>
              {/* Deliberately not a number. Approved proposals are not matched to
                  transactions yet, and showing $0 would understate real spend to
                  nothing. */}
              <dd className="font-medium text-muted-foreground">not yet tracked</dd>
            </div>
          </dl>
          <p className="mt-1 text-pretty text-xs text-muted-foreground">
            Forecast figures come from each proposal re-run against today&apos;s cash.
            Actual spend is not matched to bank transactions yet, so the two cannot be
            compared here.
          </p>
        </div>
      ) : null}

      {/* Verdict drift is the most report-worthy signal: a decision the owner made
          on old information. */}
      {changed.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs font-medium">Verdicts that moved</h3>
          <ul className="mt-1 flex flex-col gap-1">
            {changed.map((r) => (
              <li key={r.id} className="text-pretty text-xs">
                <span className="font-medium">{r.name}</span>{' '}
                <span className={r.worsened ? 'text-destructive' : 'text-muted-foreground'}>
                  {r.originalClassification} → {r.live.classification}
                </span>
                <span className="text-muted-foreground">
                  {' '}
                  (saved {fmtDate(r.createdAt)})
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Everything saved but not committed, so the report is a full picture rather
          than only the things that were approved. */}
      {considered.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs font-medium">
            Under consideration ({considered.length})
          </h3>
          <ul className="mt-1 flex flex-col gap-1">
            {considered.map((r) => (
              <li key={r.id} className="text-pretty text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{r.name}</span>{' '}
                — {PROPOSAL_TYPE_LABELS[r.proposalType as keyof typeof PROPOSAL_TYPE_LABELS] ?? r.proposalType}
                , {r.live.classification.toLowerCase()} at{' '}
                {formatCurrency(r.live.monthlyCost)}/mo
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {reviews.length === 0 ? (
        <p className="mt-4 text-pretty text-xs text-muted-foreground">
          No proposals saved yet. Analysing an investment on the Growth Planner and
          saving it will track how its answer changes as cash moves.
        </p>
      ) : null}
    </section>
  )
}
