import { PageHeader } from '@/components/page-header'
import { AdminPanel } from '@/components/admin/admin-panel'
import { SquareCsvImport } from '@/components/admin/square-csv-import'
import { CashFlowReport } from '@/components/admin/cash-flow-report'
import { LaborReport } from '@/components/admin/labor-report'
import { CogsReport } from '@/components/admin/cogs-report'
import { BillPayReport } from '@/components/admin/bill-pay-report'
import { getCheckResolutionSnapshot } from '@/lib/check-resolution-service'
import { getBillPaySnapshot } from '@/lib/bill-pay-service'
import { getCashFlowInsight } from '@/lib/cash-flow-service'
import {
  getLaborDataset,
  summarizeLabor,
  deriveMonthlyLabor,
} from '@/lib/labor-service'
import { createClient } from '@/lib/supabase/server'
import { ADMIN_TABLES } from '@/lib/admin-config'
import {
  preflightDailyImport,
  importDailyCsv,
  importItemsCsv,
  getCsvImportBatches,
} from './square-import-actions'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const supabase = await createClient()

  const results = await Promise.all(
    ADMIN_TABLES.map(async (def) => {
      let query = supabase.from(def.table).select('*')
      if (def.orderBy) {
        query = query.order(def.orderBy.column, { ascending: def.orderBy.ascending ?? true })
      }
      const { data } = await query
      return [def.key, data ?? []] as const
    }),
  )

  const data = Object.fromEntries(results) as Record<string, Record<string, unknown>[]>
  const [batches, cashFlowInsight, laborDataset, checkSnapshot, billPaySnapshot] =
    await Promise.all([
      getCsvImportBatches(),
      // Reporting shows every imported month, not the dashboard's trailing 12, so
      // the Total reconciles against the full set of statements on file.
      getCashFlowInsight({ months: Number.MAX_SAFE_INTEGER }),
      // Unfiltered for the same reason: this table reconciles against Square's
      // own payroll export, so it must cover every synced timecard.
      getLaborDataset(),
      // Same snapshot the dashboard and advisor read, so reporting cannot present a
      // margin the other two surfaces are withholding.
      getCheckResolutionSnapshot(),
      // Same bill-pay snapshot the dashboard tile and advisor read.
      getBillPaySnapshot(),
    ])
  const laborSummary = summarizeLabor(laborDataset.shifts, laborDataset.coverage)
  const laborMonthly = deriveMonthlyLabor(
    laborDataset.shifts,
    laborDataset.coverage,
  )

  return (
    <div>
      <PageHeader
        title="Admin — Data Management"
        description="Add, import, and manage the financial records that power your dashboard. Changes appear across all pages immediately."
      />
      <div className="mb-6 flex flex-col gap-4">
        <CashFlowReport insight={cashFlowInsight} />

        <LaborReport summary={laborSummary} monthly={laborMonthly} />

        <CogsReport snapshot={checkSnapshot} />

        <BillPayReport snapshot={billPaySnapshot} />

        <SquareCsvImport
          onPreflight={preflightDailyImport}
          onImportDaily={importDailyCsv}
          onImportItems={importItemsCsv}
        />

        {batches.length > 0 && (
          <section
            aria-labelledby="csv-history"
            className="rounded-lg border border-border p-4"
          >
            <h2 id="csv-history" className="text-sm font-medium">
              Recent Square imports
            </h2>
            <ul className="mt-2 flex flex-col divide-y divide-border">
              {batches.map((b) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm">{b.fileName ?? 'Untitled file'}</p>
                    <p className="text-xs text-muted-foreground">
                      {b.reportType === 'items' ? 'Item sales' : 'Daily sales'}
                      {b.periodStart && b.periodEnd
                        ? ` · ${b.periodStart} to ${b.periodEnd}`
                        : ''}
                    </p>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">
                    {b.importedCount} imported
                    {b.skippedCount > 0 && ` · ${b.skippedCount} skipped`}
                    {b.rejectedCount > 0 && ` · ${b.rejectedCount} unreadable`}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <AdminPanel data={data} />
    </div>
  )
}
