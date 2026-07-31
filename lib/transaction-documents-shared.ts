/**
 * Constants and types shared by the upload UI and the server services.
 *
 * Kept in its own module with NO `server-only` marker and no Supabase import,
 * because the dialog is a client component. Importing these from the service file
 * would drag `next/headers` into the browser bundle and blank the page.
 */

export const DOCUMENTS_BUCKET = 'transaction-documents'

/** How long a generated view link stays valid. */
export const SIGNED_URL_TTL_SECONDS = 60 * 10

/** Fallback ceiling if `document_max_upload_mb` is missing from settings. */
export const DEFAULT_MAX_UPLOAD_MB = 25

export const DOCUMENT_KINDS = [
  'check_front',
  'check_back',
  'statement',
  'receipt',
  'other',
] as const

export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  check_front: 'Check front',
  check_back: 'Check back',
  statement: 'Statement',
  receipt: 'Receipt',
  other: 'Other',
}

/**
 * What the browser is allowed to send. Bank portals export check images as
 * PNG/JPEG and statements as PDF; HEIC is included because a phone photo of a
 * paper check is a realistic way the owner will capture one.
 */
export const ACCEPTED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const

export type TransactionDocument = {
  id: string
  transactionId: string
  storagePath: string
  fileName: string
  mimeType: string | null
  fileSizeBytes: number | null
  kind: DocumentKind
  notes: string | null
  uploadedBy: string | null
  createdAt: string
}

/** Normalise a raw DB row. Shared so the service and the fetch action agree. */
export function mapDocumentRow(r: Record<string, unknown>): TransactionDocument {
  return {
    id: String(r.id),
    transactionId: String(r.transaction_id),
    storagePath: String(r.storage_path),
    fileName: String(r.file_name),
    mimeType: r.mime_type ? String(r.mime_type) : null,
    fileSizeBytes: r.file_size_bytes == null ? null : Number(r.file_size_bytes),
    kind: (DOCUMENT_KINDS as readonly string[]).includes(String(r.kind))
      ? (String(r.kind) as DocumentKind)
      : 'other',
    notes: r.notes ? String(r.notes) : null,
    uploadedBy: r.uploaded_by ? String(r.uploaded_by) : null,
    createdAt: String(r.created_at ?? ''),
  }
}
