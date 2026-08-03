import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/page-header'
import { SavedProposalDetailView } from '@/components/growth/saved-proposal-detail'
import { getSavedProposalDetail } from '@/app/growth/proposal-store'

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

  return (
    <div>
      <PageHeader
        title={detail.name}
        description="Re-checked against your current cash. The saved copy is only used to show how the answer has changed."
      />
      <SavedProposalDetailView detail={detail} />
    </div>
  )
}
