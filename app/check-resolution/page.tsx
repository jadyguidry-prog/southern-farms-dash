import { PageHeader } from '@/components/page-header'
import { CheckResolution } from '@/components/check-resolution/check-resolution'
import { getCheckResolutionDataset } from '@/lib/check-resolution-service'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Check Resolution | Southern Farms',
  description:
    'Identify who your handwritten checks were paid to so cost of goods and gross profit can be reported accurately.',
}

export default async function CheckResolutionPage() {
  const data = await getCheckResolutionDataset()

  return (
    <div>
      <PageHeader
        title="Check Resolution"
        description="Your bank export records these payments only as “CHECK #” with no payee, so this spend cannot be assigned to a category on its own. Name who was paid and your answer is stored alongside the bank record — the original is never changed, and every decision can be undone."
      />
      <CheckResolution data={data} />
    </div>
  )
}
