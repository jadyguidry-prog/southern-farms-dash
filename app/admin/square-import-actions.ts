'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { SOURCE_CSV, SOURCE_API } from '@/lib/sales-source'
import type { ParsedDailyRow, ParsedItemRow } from '@/lib/square-csv'

export type ImportPreflight = {
  /** Dates in the file that already have live API data, which outranks CSV. */
  datesCoveredByApi: string[]
  /** Dates in the file that already have a CSV row (re-import / overwrite). */
  datesAlreadyImported: string[]
}

export type ImportOutcome =
  | { ok: false; message: string }
  | {
      ok: true
      message: string
      imported: number
      updated: number
      skippedApiWins: number
      batchId: string | null
    }

/**
 * Checks a set of dates against what is already stored, so the preview can warn
 * the owner *before* anything is written. Square API data always outranks CSV,
 * so dates already covered by the API are reported rather than silently ignored.
 */
export async function preflightDailyImport(
  saleDates: string[],
): Promise<ImportPreflight> {
  if (saleDates.length === 0) {
    return { datesCoveredByApi: [], datesAlreadyImported: [] }
  }

  const supabase = await createClient()
  const unique = [...new Set(saleDates)]

  const { data, error } = await supabase
    .from('sales_daily')
    .select('sale_date, source')
    .in('sale_date', unique)

  if (error) {
    // A failed preflight must not block the import; it only removes the warning.
    console.log('[v0] preflightDailyImport failed:', error.message)
    return { datesCoveredByApi: [], datesAlreadyImported: [] }
  }

  const api = new Set<string>()
  const csv = new Set<string>()
  for (const row of (data ?? []) as { sale_date: string; source: string }[]) {
    if (row.source === SOURCE_API) api.add(row.sale_date)
    if (row.source === SOURCE_CSV) csv.add(row.sale_date)
  }

  return {
    datesCoveredByApi: [...api].sort(),
    datesAlreadyImported: [...csv].sort(),
  }
}

/**
 * Writes parsed daily rows into `sales_daily` under the CSV source.
 *
 * CSV rows are stored alongside (never on top of) API rows: the unique key
 * includes `source`, so an API sync and a CSV import for the same day coexist
 * and the resolver decides which one the UI shows. `skipApiCoveredDates` lets
 * the owner avoid importing days the API already owns.
 */
export async function importDailyCsv(input: {
  fileName: string
  rows: ParsedDailyRow[]
  rejectedCount: number
  skipApiCoveredDates: boolean
  notes?: string
}): Promise<ImportOutcome> {
  const { fileName, rows, rejectedCount, skipApiCoveredDates } = input

  if (rows.length === 0) {
    return { ok: false, message: 'Nothing to import: no valid rows were found.' }
  }

  const supabase = await createClient()

  // Which dates are already owned by the API, and which already have a CSV row?
  const pre = await preflightDailyImport(rows.map((r) => r.saleDate))
  const apiDates = new Set(pre.datesCoveredByApi)
  const existingCsvDates = new Set(pre.datesAlreadyImported)

  const toWrite = skipApiCoveredDates
    ? rows.filter((r) => !apiDates.has(r.saleDate))
    : rows
  const skippedApiWins = rows.length - toWrite.length

  if (toWrite.length === 0) {
    return {
      ok: false,
      message:
        'Every day in this file already has live Square data, which takes priority. Nothing was imported.',
    }
  }

  const periodStart = toWrite.reduce(
    (min, r) => (r.saleDate < min ? r.saleDate : min),
    toWrite[0].saleDate,
  )
  const periodEnd = toWrite.reduce(
    (max, r) => (r.saleDate > max ? r.saleDate : max),
    toWrite[0].saleDate,
  )

  // Record the batch first so every written row can point back to it.
  const { data: batch, error: batchError } = await supabase
    .from('square_csv_imports')
    .insert({
      file_name: fileName,
      report_type: 'daily',
      row_count: rows.length + rejectedCount,
      imported_count: toWrite.length,
      duplicate_count: toWrite.filter((r) => existingCsvDates.has(r.saleDate)).length,
      skipped_count: skippedApiWins,
      rejected_count: rejectedCount,
      period_start: periodStart,
      period_end: periodEnd,
      notes: input.notes ?? null,
    })
    .select('id')
    .maybeSingle()

  if (batchError) {
    return { ok: false, message: `Could not record the import: ${batchError.message}` }
  }

  const batchId = (batch as { id?: string } | null)?.id ?? null

  const payload = toWrite.map((r) => ({
    sale_date: r.saleDate,
    square_location_id: '-', // CSV exports are not location-scoped.
    source: SOURCE_CSV,
    gross_sales: r.grossSales,
    net_sales: r.netSales,
    discounts: r.discounts,
    refunds: r.refunds,
    taxes: r.taxes,
    tips: r.tips,
    processing_fees: r.fees,
    transaction_count: r.transactionCount,
    average_ticket:
      r.transactionCount > 0 ? r.netSales / r.transactionCount : null,
    import_batch_id: batchId,
    source_record_id: `csv:${r.saleDate}`,
    review_status: 'ok',
    synced_at: new Date().toISOString(),
  }))

  const updated = toWrite.filter((r) => existingCsvDates.has(r.saleDate)).length

  const { error } = await supabase
    .from('sales_daily')
    .upsert(payload, { onConflict: 'sale_date,square_location_id,source' })

  if (error) {
    return { ok: false, message: `Import failed: ${error.message}` }
  }

  revalidatePath('/admin')
  revalidatePath('/sales')
  revalidatePath('/')

  const parts = [`${toWrite.length - updated} day(s) added`]
  if (updated > 0) parts.push(`${updated} updated`)
  if (skippedApiWins > 0) parts.push(`${skippedApiWins} skipped (live Square data wins)`)
  if (rejectedCount > 0) parts.push(`${rejectedCount} row(s) could not be read`)

  return {
    ok: true,
    message: parts.join(' · '),
    imported: toWrite.length - updated,
    updated,
    skippedApiWins,
    batchId,
  }
}

/**
 * Writes parsed item rows into `sales_by_category`, aggregating by category.
 * Items without a category are grouped under the item name so nothing is lost.
 */
export async function importItemsCsv(input: {
  fileName: string
  rows: ParsedItemRow[]
  rejectedCount: number
}): Promise<ImportOutcome> {
  const { fileName, rows, rejectedCount } = input

  if (rows.length === 0) {
    return { ok: false, message: 'Nothing to import: no valid rows were found.' }
  }

  const supabase = await createClient()

  // Aggregate to category level, which is what the reporting views consume.
  const byCategory = new Map<
    string,
    { revenue: number; units: number; start: string | null; end: string | null }
  >()

  for (const r of rows) {
    const key = r.categoryName?.trim() || r.itemName.trim() || 'Uncategorized'
    const existing = byCategory.get(key)
    if (existing) {
      existing.revenue += r.netSales
      existing.units += r.units
      if (r.periodStart && (!existing.start || r.periodStart < existing.start)) {
        existing.start = r.periodStart
      }
      if (r.periodEnd && (!existing.end || r.periodEnd > existing.end)) {
        existing.end = r.periodEnd
      }
    } else {
      byCategory.set(key, {
        revenue: r.netSales,
        units: r.units,
        start: r.periodStart,
        end: r.periodEnd,
      })
    }
  }

  const periods = rows.map((r) => r.periodStart).filter((d): d is string => !!d)
  const periodStart = periods.length > 0 ? periods.sort()[0] : null
  const periodEnds = rows.map((r) => r.periodEnd).filter((d): d is string => !!d)
  const periodEnd = periodEnds.length > 0 ? periodEnds.sort().reverse()[0] : null

  const { data: batch, error: batchError } = await supabase
    .from('square_csv_imports')
    .insert({
      file_name: fileName,
      report_type: 'items',
      row_count: rows.length + rejectedCount,
      imported_count: byCategory.size,
      rejected_count: rejectedCount,
      period_start: periodStart,
      period_end: periodEnd,
    })
    .select('id')
    .maybeSingle()

  if (batchError) {
    return { ok: false, message: `Could not record the import: ${batchError.message}` }
  }

  const payload = [...byCategory.entries()].map(([name, v]) => ({
    category_name: name,
    // The unique key needs a concrete date; the sentinel means "no period given".
    period_start: v.start ?? periodStart ?? '1900-01-01',
    period_end: v.end ?? periodEnd,
    revenue: v.revenue,
    units: v.units,
    source: SOURCE_CSV,
    synced_at: new Date().toISOString(),
  }))

  const { error } = await supabase
    .from('sales_by_category')
    .upsert(payload, { onConflict: 'category_name,period_start,source' })

  if (error) {
    return { ok: false, message: `Import failed: ${error.message}` }
  }

  revalidatePath('/admin')
  revalidatePath('/sales')

  const parts = [`${byCategory.size} categor${byCategory.size === 1 ? 'y' : 'ies'} imported`]
  if (rejectedCount > 0) parts.push(`${rejectedCount} row(s) could not be read`)

  return {
    ok: true,
    message: parts.join(' · '),
    imported: byCategory.size,
    updated: 0,
    skippedApiWins: 0,
    batchId: (batch as { id?: string } | null)?.id ?? null,
  }
}

export type CsvImportBatch = {
  id: string
  fileName: string | null
  reportType: string | null
  importedCount: number
  skippedCount: number
  rejectedCount: number
  periodStart: string | null
  periodEnd: string | null
  createdAt: string
}

/** Recent CSV imports, so the owner can see what has already been brought in. */
export async function getCsvImportBatches(limit = 8): Promise<CsvImportBatch[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('square_csv_imports')
    .select(
      'id, file_name, report_type, imported_count, skipped_count, rejected_count, period_start, period_end, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) return []

  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>
    return {
      id: String(row.id),
      fileName: (row.file_name as string | null) ?? null,
      reportType: (row.report_type as string | null) ?? null,
      importedCount: Number(row.imported_count ?? 0),
      skippedCount: Number(row.skipped_count ?? 0),
      rejectedCount: Number(row.rejected_count ?? 0),
      periodStart: (row.period_start as string | null) ?? null,
      periodEnd: (row.period_end as string | null) ?? null,
      createdAt: String(row.created_at),
    }
  })
}
