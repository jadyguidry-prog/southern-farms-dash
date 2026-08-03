import Link from 'next/link'
import { PageHeader } from '@/components/page-header'
import { SavedProposalsList } from '@/components/growth/saved-proposals-list'
import { listSavedProposals } from '@/app/growth/proposal-store'
import { buttonVariants } from '@/components/ui/button'

export const metadata = {
  title: 'Saved Proposals | Southern Farms',
  description:
    'Growth proposals you have saved, each re-checked against your current cash so you can see how the answer moved.',
}

// Saved-proposal verdicts depend on live cash, so never serve a cached page.
export const dynamic = 'force-dynamic'

export default async function SavedProposalsPage() {
  const proposals = await listSavedProposals()

  return (
    <div>
      <PageHeader
        title="Saved proposals"
        description="Each one is re-checked against your current cash when you open it, so you can see whether something that did not fit before fits now — or the other way around."
        action={
          <Link href="/growth" className={buttonVariants({ variant: 'outline' })}>
            Back to planner
          </Link>
        }
      />
      <SavedProposalsList proposals={proposals} />
    </div>
  )
}
