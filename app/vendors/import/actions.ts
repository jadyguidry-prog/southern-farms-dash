'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import {
  duplicateKey,
  normalizeDescription,
  statementMonthOf,
  type TransactionType,
} from '@/lib/transactions'
import { getMatchRules } from '@/lib/transaction-queries'
import { matchVendor } from '@/lib/transactions'

/** A row the client has already parsed, mapped, and previewed. */
export type StagedRow = {
  transactionDate: string
  postedDate: string | null
  description: string
  amount: number // signed: negative = money out
  transactionType: TransactionType
  accountName: string | null
  externalTransactionId: string | null
  expenseCategory: string | null
}

export type CommitResult = {
  ok: boolean
  error?: string
  imported: number
  duplicates: number
  matched: number
  unmatched: number
}

/**
 * Persist a previewed batch of transactions.
 *
 * Duplicate protection is re-checked here on the server against what is
 * actually in the database, not just within the file, because the client
 * preview can be stale by the time it is submitted.
 */
export async function commitImport(
  fileName: string,
  rows: StagedRow[],
  overrideDuplicates: boolean,
): Promise<CommitResult> {
  const empty = { imported: 0, duplicates: 0, matched: 0, unmatched: 0 }

  if (!fileName.trim()) {
    return { ok: false, error: 'Missing file name.', ...empty }
  }
  if (rows.length === 0) {
    return { ok: false, error: 'There are no rows to import.', ...empty }
  }

  const supabase = await createClient()
  const rules = await getMatchRules()

  // Pull existing rows in the date range covered by this file so we can build
  // the duplicate set without loading the entire table.
  const dates = rows.map((r) => r.transactionDate).sort()
  const { data: existing } = await supabase
    .from('financial_transactions')
    .select('transaction_date, amount, normalized_description, account_name, external_transaction_id')
    .is('deleted_at', null)
    .gte('transaction_date', dates[0])
    .lte('transaction_date', dates[dates.length - 1])

  const seen = new Set<string>()
  for (const row of existing ?? []) {
    seen.add(
      duplicateKey({
        transaction_date: String(row.transaction_date),
        amount: Number(row.amount ?? 0),
        normalized_description: row.normalized_description ?? '',
        account_name: row.account_name ?? '',
        external_transaction_id: row.external_transaction_id ?? null,
      }),
    )
  }

  const toInsert: Record<string, unknown>[] = []
  let duplicates = 0
  let matched = 0
  let unmatched = 0

  for (const row of rows) {
    const normalized = normalizeDescription(row.description)
    // Amount is stored as a positive magnitude; direction lives in the type.
    const magnitude = Math.abs(row.amount)

    const key = duplicateKey({
      transaction_date: row.transactionDate,
      amount: magnitude,
      normalized_description: normalized,
      account_name: row.accountName ?? '',
      external_transaction_id: row.externalTransactionId,
    })

    if (seen.has(key) && !overrideDuplicates) {
      duplicates += 1
      continue
    }
    seen.add(key)

    const match = matchVendor(normalized, rules)
    if (match) matched += 1
    else unmatched += 1

    toInsert.push({
      transaction_date: row.transactionDate,
      posted_date: row.postedDate,
      description: row.description,
      normalized_description: normalized,
      amount: magnitude,
      transaction_type: row.transactionType,
      account_name: row.accountName,
      statement_month: statementMonthOf(row.transactionDate),
      vendor_id: match?.vendorId ?? null,
      expense_category: row.expenseCategory,
      source: 'csv_import',
      source_file_name: fileName,
      external_transaction_id: row.externalTransactionId,
      // A confident rule match is trusted; everything else is queued for the
      // owner to confirm rather than being quietly accepted.
      review_status: match && match.confidence >= 90 ? 'matched' : 'needs_review',
    })
  }

  const { data: batch } = await supabase
    .from('transaction_import_batches')
    .insert({
      file_name: fileName,
      account_name: rows[0]?.accountName ?? null,
      row_count: rows.length,
      status: 'processing',
    })
    .select('id')
    .maybeSingle()

  if (toInsert.length > 0) {
    // Chunked so a large statement doesn't exceed the request size limit.
    const CHUNK = 500
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const { error } = await supabase
        .from('financial_transactions')
        .insert(toInsert.slice(i, i + CHUNK))

      if (error) {
        if (batch?.id) {
          await supabase
            .from('transaction_import_batches')
            .update({ status: 'failed', error_count: toInsert.length })
            .eq('id', batch.id)
        }
        return { ok: false, error: error.message, ...empty }
      }
    }
  }

  if (batch?.id) {
    await supabase
      .from('transaction_import_batches')
      .update({
        status: 'completed',
        imported_count: toInsert.length,
        duplicate_count: duplicates,
        completed_at: new Date().toISOString(),
      })
      .eq('id', batch.id)
  }

  revalidatePath('/vendors')
  revalidatePath('/vendors/import')
  revalidatePath('/vendors/transactions')

  return {
    ok: true,
    imported: toInsert.length,
    duplicates,
    matched,
    unmatched,
  }
}

/**
 * Check a set of staged rows against the database and report which are
 * duplicates and how many would match a vendor. Read-only: lets the owner see
 * the outcome before anything is written.
 */
export async function previewImport(rows: StagedRow[]) {
  if (rows.length === 0) {
    return { duplicateKeys: [] as string[], matchedCount: 0, unmatchedCount: 0 }
  }

  const supabase = await createClient()
  const rules = await getMatchRules()
  const dates = rows.map((r) => r.transactionDate).sort()

  const { data: existing } = await supabase
    .from('financial_transactions')
    .select('transaction_date, amount, normalized_description, account_name, external_transaction_id')
    .is('deleted_at', null)
    .gte('transaction_date', dates[0])
    .lte('transaction_date', dates[dates.length - 1])

  const seen = new Set<string>()
  for (const row of existing ?? []) {
    seen.add(
      duplicateKey({
        transaction_date: String(row.transaction_date),
        amount: Number(row.amount ?? 0),
        normalized_description: row.normalized_description ?? '',
        account_name: row.account_name ?? '',
        external_transaction_id: row.external_transaction_id ?? null,
      }),
    )
  }

  const duplicateKeys: string[] = []
  let matchedCount = 0
  let unmatchedCount = 0
  const withinFile = new Set<string>()

  for (const row of rows) {
    const normalized = normalizeDescription(row.description)
    const key = duplicateKey({
      transaction_date: row.transactionDate,
      amount: Math.abs(row.amount),
      normalized_description: normalized,
      account_name: row.accountName ?? '',
      external_transaction_id: row.externalTransactionId,
    })

    if (seen.has(key) || withinFile.has(key)) duplicateKeys.push(key)
    withinFile.add(key)

    if (matchVendor(normalized, rules)) matchedCount += 1
    else unmatchedCount += 1
  }

  return { duplicateKeys, matchedCount, unmatchedCount }
}
