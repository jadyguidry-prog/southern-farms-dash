import Link from 'next/link'
import { Upload, ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TransactionReview } from '@/components/vendors/transaction-review'
import { PayeeGroups } from '@/components/vendors/payee-groups'
import { RecurringSuggestions } from '@/components/vendors/recurring-suggestions'
import { getVendorDirectory } from '@/lib/queries'
import {
  getTransactions,
  getTransactionCounts,
  getRecurringSuggestions,
  getPayeeGroups,
  getVendorNameMap,
} from '@/lib/transaction-queries'

export const dynamic = 'force-dynamic'

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ vendor?: string }>
}) {
  const { vendor: initialVendorId } = await searchParams
  const [transactions, counts, directory, suggestions, groups, vendorNames] =
    await Promise.all([
      getTransactions(),
      getTransactionCounts(),
      getVendorDirectory(),
      getRecurringSuggestions(),
      getPayeeGroups(),
      getVendorNameMap(),
    ])

  const vendorOptions = directory
    .filter((v) => !v.archived)
    .map((v) => ({ id: v.id, name: v.displayName || v.name }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // Category options come from the vendors already on file, so the picker stays
  // in sync with the directory instead of using a hardcoded list.
  const categories = [...new Set(directory.map((v) => v.category).filter(Boolean))].sort()

  const openSuggestions = suggestions.filter((s) => !s.alreadyTracked).length

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-2">
        <Link
          href="/vendors"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to Vendor Management
        </Link>
      </div>

      <PageHeader
        title="Transactions"
        description="Imported bank and credit-card activity, matched to vendors. Review matches, categorize spend, and turn repeating charges into tracked obligations."
        action={
          <Link
            href="/vendors/import"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            <Upload className="size-4" aria-hidden="true" />
            Import statement
          </Link>
        }
      />

      <Tabs defaultValue="review" className="mt-4">
        <TabsList>
          <TabsTrigger value="review">
            Review by payee
            {groups.totals.groups > 0 ? ` (${groups.totals.groups})` : ''}
          </TabsTrigger>
          <TabsTrigger value="transactions">All transactions</TabsTrigger>
          <TabsTrigger value="recurring">
            Recurring{openSuggestions > 0 ? ` (${openSuggestions})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="review">
          <PayeeGroups
            payeeGroups={groups.payeeGroups}
            genericGroups={groups.genericGroups}
            totals={groups.totals}
            vendors={vendorOptions}
            categories={categories}
            vendorNames={vendorNames}
          />
        </TabsContent>

        <TabsContent value="transactions">
          <TransactionReview
            transactions={transactions}
            vendors={vendorOptions}
            counts={counts}
            categories={categories}
            initialVendorId={
              initialVendorId && vendorOptions.some((v) => v.id === initialVendorId)
                ? initialVendorId
                : undefined
            }
          />
        </TabsContent>

        <TabsContent value="recurring">
          <RecurringSuggestions suggestions={suggestions} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
