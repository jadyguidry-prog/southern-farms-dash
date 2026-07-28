'use client'

import { useRef, useState, useTransition } from 'react'
import Papa from 'papaparse'
import {
  Upload,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  Info,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/data'
import {
  detectReportType,
  parseDailyReport,
  parseItemsReport,
  summarizeDaily,
  summarizeItems,
  type CsvRow,
  type ParsedDailyRow,
  type ParsedItemRow,
  type RejectedRow,
  type SquareCsvReportType,
} from '@/lib/square-csv'
import type {
  ImportOutcome,
  ImportPreflight,
} from '@/app/admin/square-import-actions'

type Props = {
  onPreflight: (saleDates: string[]) => Promise<ImportPreflight>
  onImportDaily: (input: {
    fileName: string
    rows: ParsedDailyRow[]
    rejectedCount: number
    skipApiCoveredDates: boolean
  }) => Promise<ImportOutcome>
  onImportItems: (input: {
    fileName: string
    rows: ParsedItemRow[]
    rejectedCount: number
  }) => Promise<ImportOutcome>
}

type Preview =
  | {
      kind: 'daily'
      fileName: string
      rows: ParsedDailyRow[]
      rejected: RejectedRow[]
      matched: Record<string, string>
      ignored: string[]
      preflight: ImportPreflight | null
    }
  | {
      kind: 'items'
      fileName: string
      rows: ParsedItemRow[]
      rejected: RejectedRow[]
      matched: Record<string, string>
      ignored: string[]
    }

export function SquareCsvImport({
  onPreflight,
  onImportDaily,
  onImportItems,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [skipApiDates, setSkipApiDates] = useState(true)
  const [isPending, startTransition] = useTransition()

  function reset() {
    setPreview(null)
    setParseError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  function handleFile(file: File) {
    setParseError(null)
    setPreview(null)

    Papa.parse<CsvRow>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: async (result) => {
        const headers = result.meta.fields ?? []
        const rows = (result.data ?? []).filter(Boolean)

        if (rows.length === 0) {
          setParseError('That file has no data rows.')
          return
        }

        const type: SquareCsvReportType | null = detectReportType(headers)
        if (!type) {
          setParseError(
            'This does not look like a Square sales or items export. Expected a date column with sales totals, or an item/category column.',
          )
          return
        }

        if (type === 'daily') {
          const parsed = parseDailyReport(headers, rows)
          if (parsed.rows.length === 0) {
            setParseError(
              'No usable rows were found. Every row was missing a readable date or sales figure.',
            )
            return
          }
          // Ask the server what it already has, so the preview can warn first.
          let preflight: ImportPreflight | null = null
          try {
            preflight = await onPreflight(parsed.rows.map((r) => r.saleDate))
          } catch {
            preflight = null
          }
          setPreview({
            kind: 'daily',
            fileName: file.name,
            rows: parsed.rows,
            rejected: parsed.rejected,
            matched: parsed.matched,
            ignored: parsed.ignored,
            preflight,
          })
        } else {
          const parsed = parseItemsReport(headers, rows)
          if (parsed.rows.length === 0) {
            setParseError('No usable item rows were found in that file.')
            return
          }
          setPreview({
            kind: 'items',
            fileName: file.name,
            rows: parsed.rows,
            rejected: parsed.rejected,
            matched: parsed.matched,
            ignored: parsed.ignored,
          })
        }
      },
      error: (err) => setParseError(`Could not read that file: ${err.message}`),
    })
  }

  function handleImport() {
    if (!preview) return

    startTransition(async () => {
      const outcome =
        preview.kind === 'daily'
          ? await onImportDaily({
              fileName: preview.fileName,
              rows: preview.rows,
              rejectedCount: preview.rejected.length,
              skipApiCoveredDates: skipApiDates,
            })
          : await onImportItems({
              fileName: preview.fileName,
              rows: preview.rows,
              rejectedCount: preview.rejected.length,
            })

      if (outcome.ok) {
        toast.success('Import complete', { description: outcome.message })
        reset()
      } else {
        toast.error('Import failed', { description: outcome.message })
      }
    })
  }

  const dailySummary =
    preview?.kind === 'daily' ? summarizeDaily(preview.rows) : null
  const itemsSummary =
    preview?.kind === 'items' ? summarizeItems(preview.rows) : null

  const apiCovered = preview?.kind === 'daily' ? preview.preflight?.datesCoveredByApi ?? [] : []
  const alreadyImported =
    preview?.kind === 'daily' ? preview.preflight?.datesAlreadyImported ?? [] : []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Import a Square CSV</CardTitle>
        <CardDescription>
          Use this for history older than your live sync, or if you have no API
          token yet. Export {'"'}Sales summary{'"'} or {'"'}Item sales{'"'} from
          the Square dashboard. Live synced data always takes priority over an
          imported file.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* File picker */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="square-csv">CSV file</Label>
          <input
            ref={inputRef}
            id="square-csv"
            type="file"
            accept=".csv,text/csv"
            className="block w-full cursor-pointer rounded-md border border-input bg-background text-sm file:mr-3 file:cursor-pointer file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:font-medium"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleFile(file)
            }}
          />
        </div>

        {parseError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <p className="text-foreground">{parseError}</p>
          </div>
        )}

        {preview && (
          <div className="flex flex-col gap-4">
            {/* What we detected */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="gap-1.5">
                <FileSpreadsheet className="size-3.5" aria-hidden="true" />
                {preview.kind === 'daily' ? 'Daily sales summary' : 'Item sales'}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {preview.fileName}
              </span>
            </div>

            {/* Totals */}
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {preview.kind === 'daily' && dailySummary && (
                <>
                  <Stat label="Days" value={String(dailySummary.rowCount)} />
                  <Stat
                    label="Net sales"
                    value={formatCurrency(dailySummary.totalNet)}
                  />
                  <Stat
                    label="Gross sales"
                    value={formatCurrency(dailySummary.totalGross)}
                  />
                  <Stat
                    label="Date range"
                    value={
                      dailySummary.periodStart && dailySummary.periodEnd
                        ? `${dailySummary.periodStart} to ${dailySummary.periodEnd}`
                        : '—'
                    }
                  />
                </>
              )}
              {preview.kind === 'items' && itemsSummary && (
                <>
                  <Stat label="Rows" value={String(itemsSummary.rowCount)} />
                  <Stat
                    label="Categories"
                    value={String(itemsSummary.categoryCount)}
                  />
                  <Stat
                    label="Gross sales"
                    value={formatCurrency(itemsSummary.totalGross)}
                  />
                </>
              )}
            </dl>

            {/* Overlap warnings */}
            {apiCovered.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 p-3 text-sm">
                <Info
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="flex flex-col gap-2">
                  <p>
                    {apiCovered.length} day
                    {apiCovered.length === 1 ? '' : 's'} in this file already
                    {apiCovered.length === 1 ? ' has' : ' have'} live Square data,
                    which outranks a CSV import.
                  </p>
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="skip-api"
                      checked={skipApiDates}
                      onCheckedChange={(v) => setSkipApiDates(v === true)}
                    />
                    <Label
                      htmlFor="skip-api"
                      className="text-sm font-normal leading-snug"
                    >
                      Skip those days (recommended). Unchecking stores the CSV
                      figures alongside the live data without replacing it.
                    </Label>
                  </div>
                </div>
              </div>
            )}

            {alreadyImported.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {alreadyImported.length} day
                {alreadyImported.length === 1 ? '' : 's'} were imported from a
                CSV before and will be updated with the figures in this file.
              </p>
            )}

            {preview.rejected.length > 0 && (
              <details className="rounded-md border border-border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  {preview.rejected.length} row
                  {preview.rejected.length === 1 ? '' : 's'} could not be read
                </summary>
                <ul className="mt-2 flex flex-col gap-1">
                  {preview.rejected.slice(0, 10).map((r) => (
                    <li key={r.rowNumber} className="text-xs text-muted-foreground">
                      Row {r.rowNumber}: {r.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {/* Row preview */}
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {preview.kind === 'daily' ? (
                      <>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Gross</TableHead>
                        <TableHead className="text-right">Net</TableHead>
                        <TableHead className="text-right">Refunds</TableHead>
                        <TableHead className="text-right">Txns</TableHead>
                      </>
                    ) : (
                      <>
                        <TableHead>Item</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Units</TableHead>
                        <TableHead className="text-right">Net</TableHead>
                      </>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.kind === 'daily'
                    ? preview.rows.slice(0, 8).map((r) => (
                        <TableRow key={r.rowNumber}>
                          <TableCell className="font-mono text-xs">
                            {r.saleDate}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {formatCurrency(r.grossSales)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {formatCurrency(r.netSales)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {formatCurrency(r.refunds)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {r.transactionCount}
                          </TableCell>
                        </TableRow>
                      ))
                    : preview.rows.slice(0, 8).map((r) => (
                        <TableRow key={r.rowNumber}>
                          <TableCell className="text-xs">{r.itemName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {r.categoryName ?? '—'}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {r.units}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {formatCurrency(r.netSales)}
                          </TableCell>
                        </TableRow>
                      ))}
                </TableBody>
              </Table>
            </div>
            {preview.rows.length > 8 && (
              <p className="text-xs text-muted-foreground">
                Showing the first 8 of {preview.rows.length} rows.
              </p>
            )}

            {preview.ignored.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Columns ignored: {preview.ignored.slice(0, 8).join(', ')}
                {preview.ignored.length > 8 ? '…' : ''}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={handleImport} disabled={isPending}>
                {isPending ? (
                  'Importing…'
                ) : (
                  <>
                    <Upload className="size-4" aria-hidden="true" />
                    Import {preview.rows.length} row
                    {preview.rows.length === 1 ? '' : 's'}
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={reset} disabled={isPending}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {!preview && !parseError && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              Nothing is written until you review the preview and confirm.
              Column names are matched automatically, so Square{"'"}s exact
              export format does not need to match.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border p-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm font-medium">{value}</dd>
    </div>
  )
}
