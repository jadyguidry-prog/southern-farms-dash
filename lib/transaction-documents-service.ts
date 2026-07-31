import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { fetchAllPages } from '@/lib/paginate'

import {
  DEFAULT_MAX_UPLOAD_MB,
  DOCUMENTS_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  mapDocumentRow as mapRow,
  type TransactionDocument,
} from '@/lib/transaction-documents-shared'

// Re-exported so server callers can keep importing everything from one place,
// while the client imports the same values from the shared module directly.
export {
  DOCUMENTS_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  ACCEPTED_MIME_TYPES,
  type DocumentKind,
  type TransactionDocument,
} from '@/lib/transaction-documents-shared'

/** Upload ceiling in bytes, read from settings so it is tunable without a deploy. */
export async function getMaxUploadBytes(): Promise<number> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('business_settings')
    .select('value')
    .eq('setting_key', 'document_max_upload_mb')
    .maybeSingle()

  const mb = Number(data?.value)
  const safe = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_UPLOAD_MB
  return Math.round(safe * 1024 * 1024)
}

/**
 * Build the storage path for an upload.
 *
 * Partitioned by transaction id, and the filename is prefixed with a timestamp
 * so uploading two scans named "image.jpg" cannot collide. The original name is
 * sanitised rather than trusted: it reaches us from the browser and would
 * otherwise be free to contain path separators.
 */
export function buildStoragePath(transactionId: string, fileName: string): string {
  const safeName = fileName
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-80)
  return `${transactionId}/${Date.now()}-${safeName}`
}

/** Documents for one transaction, oldest first so front/back read in order. */
export async function getDocumentsForTransaction(
  transactionId: string,
): Promise<TransactionDocument[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('transaction_documents')
    .select('*')
    .eq('transaction_id', transactionId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })

  return (data ?? []).map(mapRow)
}

/**
 * How many documents each transaction has.
 *
 * Returns a plain count map rather than the rows themselves: the list views only
 * need a badge, and fetching every attachment row to render "2" would grow with
 * the archive forever.
 */
export async function getDocumentCounts(): Promise<Map<string, number>> {
  const supabase = await createClient()
  const rows = await fetchAllPages<{ transaction_id: string }>(
    (from, to) =>
      supabase
        .from('transaction_documents')
        .select('transaction_id')
        .is('deleted_at', null)
        .range(from, to),
    'transaction document counts',
  )

  const counts = new Map<string, number>()
  for (const r of rows) {
    const id = String(r.transaction_id)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/**
 * Short-lived signed URLs for viewing.
 *
 * The bucket is private, so there is no permanent public URL to store. Links are
 * minted per request and expire, which is what keeps bank statements and check
 * images from being readable by anyone who happens to get the address.
 */
export async function getSignedUrls(
  storagePaths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (storagePaths.length === 0) return out

  const supabase = await createClient()
  const { data } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrls(storagePaths, SIGNED_URL_TTL_SECONDS)

  for (const item of data ?? []) {
    if (item.signedUrl && item.path) out.set(String(item.path), item.signedUrl)
  }
  return out
}

export type DocumentCoverage = {
  /** Uncategorized checks that still have no scan attached. */
  checksMissingDocs: number
  checksMissingDocsAmount: number
  /** Uncategorized checks that now have at least one scan. */
  checksWithDocs: number
  checksWithDocsAmount: number
  totalDocuments: number
}

/**
 * Progress on documenting the unidentified checks.
 *
 * Deliberately measured in DOLLARS as well as counts: 201 checks are not equally
 * important, and one $32,127 check matters more than fifty small ones. Surfacing
 * only a count would make a nearly-finished job look barely started.
 */
export async function getDocumentCoverage(): Promise<DocumentCoverage> {
  const supabase = await createClient()

  const [txns, counts] = await Promise.all([
    fetchAllPages<{ id: string; amount: number | string; description: string | null }>(
      (from, to) =>
        supabase
          .from('financial_transactions')
          .select('id, amount, description')
          .is('deleted_at', null)
          .is('expense_category', null)
          .neq('review_status', 'excluded')
          .ilike('description', 'check%')
          .range(from, to),
      'undocumented checks',
    ),
    getDocumentCounts(),
  ])

  let missing = 0
  let missingAmount = 0
  let withDocs = 0
  let withAmount = 0

  for (const t of txns) {
    const amount = Math.abs(Number(t.amount ?? 0))
    if ((counts.get(String(t.id)) ?? 0) > 0) {
      withDocs += 1
      withAmount += amount
    } else {
      missing += 1
      missingAmount += amount
    }
  }

  let totalDocuments = 0
  for (const n of counts.values()) totalDocuments += n

  return {
    checksMissingDocs: missing,
    checksMissingDocsAmount: missingAmount,
    checksWithDocs: withDocs,
    checksWithDocsAmount: withAmount,
    totalDocuments,
  }
}
