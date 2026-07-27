import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { TransactionImport } from '@/components/vendors/transaction-import'
import { getImportBatches, getKnownAccountNames } from '@/lib/transaction-queries'

export default async function ImportPage() {
  const [accountNames, batches] = await Promise.all([
    getKnownAccountNames(),
    getImportBatches(),
  ])

  return (
    <div className="mx-auto max-w-5xl">
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link href="/vendors">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to vendors
        </Link>
      </Button>

      <PageHeader
        title="Import Transactions"
        description="Upload a bank or credit card CSV. Transactions are matched to your vendors automatically, duplicates are flagged, and recurring charges are detected for your review."
      />

      <TransactionImport accountNames={accountNames} />

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Recent imports</CardTitle>
          <CardDescription>
            {batches.length === 0
              ? 'No files have been imported yet.'
              : 'The most recent files you have brought in.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {batches.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Once you import a CSV it will be listed here with a count of how many
              rows were added and how many were skipped.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {batches.map((b) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{b.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(b.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                      {b.accountName ? ` · ${b.accountName}` : ''}
                    </p>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">
                    {b.importedCount} added
                    {b.duplicateCount > 0 && ` · ${b.duplicateCount} skipped`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
