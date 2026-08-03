// Growth-commitment reporting card for the Admin surface (this app's Reporting page).
//
// Reads the SAME `getGrowthPlannerSnapshot` and `getSavedProposalReviews` the
// dashboard card and the AI Advisor read, so the recommended commitment and the
// per-proposal verdicts cannot differ between the three surfaces.
//
// On "forecast vs actual": actuals are now REAL, from owner-recorded activation and
// monthly outcomes (M5), shared via `getSavedProposalReviews` so this card and the
// proposal detail page cannot disagree. The original rule still holds, though —
// an unrecorded commitment shows "not recorded yet", never $0, because a literal
// zero would read as "this cost nothing", the opposite of the truth. Actuals are
// still owner-entered rather than matched to bank transactions.

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
  const committedOneTime = approved.reduce((sum, r) => sum + r.live.upfrontCost, 0)

  // Actuals, from the SAME shared summaries the detail page renders.
  //
  // Two rules keep this honest. First, only commitments with at least one recorded
  // month contribute — so `actualRecorded` stays null (not $0) until something real
  // has been entered. Second, the forecast side of the comparison is each
  // commitment's `forecastCostOverRecorded`, covering only its recorded months;
  // comparing full-term forecasts against a partial history would make every
  // commitment look dramatically under budget.
  const tracked = approved.filter((r) => r.outcomes.actualCostOverRecorded != null)
  const actualRecorded =
    tracked.length > 0
      ? tracked.reduce((sum, r) => sum + (r.outcomes.actualCostOverRecorded ?? 0), 0)
      : null
  const forecastOverTracked = tracked.reduce(
    (sum, r) => sum + r.outcomes.forecastCostOverRecorded,
    0,
  )
  const trackedVariance =
    actualRecorded == null ? null : Math.round((actualRecorded - forecastOverTracked) * 100) / 100
  const trackedMonths = tracked.reduce((sum, r) => sum + r.outcomes.monthsRecorded, 0)
  const untrackedApproved = approved.length - tracked.length
  const notCovering = approved.filter(
    (r) =>
      r.outcomes.verdict === 'not_covering' ||
      r.outcomes.verdict === 'covering_at_optimistic_margins',
  )

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
              {/* A real figure now that outcomes are recorded — but still only ever a
                  number when something was actually entered. `null` means unrecorded,
                  and rendering that as $0 would read as "cost nothing". */}
              <dd
                className={`font-medium ${actualRecorded == null ? 'text-muted-foreground' : ''}`}
              >
                {actualRecorded == null ? 'not recorded yet' : formatCurrency(actualRecorded)}
              </dd>
            </div>
            {actualRecorded != null ? (
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">vs forecast:</dt>
                <dd
                  className={`font-medium ${
                    trackedVariance == null
                      ? ''
                      : trackedVariance > 0
                        ? 'text-amber-700'
                        : trackedVariance < 0
                          ? 'text-emerald-700'
                          : ''
                  }`}
                >
                  {trackedVariance == null
                    ? '—'
                    : `${trackedVariance > 0 ? '+' : ''}${formatCurrency(trackedVariance)}`}
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="mt-1 text-pretty text-xs text-muted-foreground">
            Forecast figures come from each proposal re-run against today&apos;s cash.{' '}
            {actualRecorded == null
              ? 'No actual costs have been recorded against these commitments yet, so there is nothing to compare.'
              : `Actuals cover the ${trackedMonths} ${trackedMonths === 1 ? 'month' : 'months'} recorded so far, compared against the forecast for those same months.${untrackedApproved > 0 ? ` ${untrackedApproved} approved ${untrackedApproved === 1 ? 'commitment has' : 'commitments have'} nothing recorded.` : ''}`}
          </p>
          {/* Commitments whose recorded sales cannot justify them are the single most
              report-worthy fact here, so they are named rather than averaged away. */}
          {notCovering.length > 0 ? (
            <div className="mt-3">
              <h3 className="text-xs font-medium">Not covering their cost</h3>
              <ul className="mt-1 flex flex-col gap-1">
                {notCovering.map((r) => (
                  <li key={r.id} className="text-pretty text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{r.name}</span> —{' '}
                    {r.outcomes.headline}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
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
