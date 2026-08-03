import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/page-header'
import { SavedProposalDetailView } from '@/components/growth/saved-proposal-detail'
import { getSavedProposalDetail } from '@/app/growth/proposal-store'
import { getSavedProposalReviews } from '@/lib/growth-proposal-review'
import { OutcomeTracker } from '@/components/growth/outcome-tracker'

// The verdict is re-run against live cash on every view, so this must never cache.
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await getSavedProposalDetail(id)
  return {
    title: detail ? `${detail.name} | Saved Proposal` : 'Saved Proposal | Southern Farms',
  }
}

export default async function SavedProposalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // Next.js 16: params is async and must be awaited.
  const { id } = await params
  const detail = await getSavedProposalDetail(id)
  if (!detail) notFound()

  // Outcome figures come from the SHARED review loader rather than being recomputed
  // here, so this page and the admin report can never report different actuals.
  // Both loaders are `cache()`-wrapped, so this costs one projection per request.
  const review = (await getSavedProposalReviews()).find((r) => r.id === id)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageHeader
          title={detail.name}
          description="Re-checked against your current cash. The saved copy is only used to show how the answer has changed."
        />
        <SavedProposalDetailView detail={detail} />
      </div>
      {review ? (
        <OutcomeTracker
          proposalId={id}
          approved={review.approvedAt != null}
          outcomes={review.outcomes}
        />
      ) : null}
    </div>
  )
}
