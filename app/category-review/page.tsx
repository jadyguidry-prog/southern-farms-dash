import { PageHeader } from '@/components/page-header'
import { CategoryReview } from '@/components/category-review/category-review'
import { getCategoryReviewData } from '@/lib/category-review-service'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Category Review | Southern Farms',
  description:
    'Review duplicate spending categories, mis-typed transactions, and uncategorized checks before they affect your reports.',
}

export default async function CategoryReviewPage() {
  const data = await getCategoryReviewData()

  return (
    <div>
      <PageHeader
        title="Category Review"
        description="Clean up how transactions are categorized so your reports and AI Advisor work from accurate numbers. Every change is proposed for your approval first and can be undone — nothing here is applied automatically."
      />
      <CategoryReview data={data} />
    </div>
  )
}
