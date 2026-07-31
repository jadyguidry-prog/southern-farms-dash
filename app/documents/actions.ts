'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import {
  buildStoragePath,
  getMaxUploadBytes,
} from '@/lib/transaction-documents-service'
import {
  ACCEPTED_MIME_TYPES,
  DOCUMENTS_BUCKET,
  DOCUMENT_KINDS,
  SIGNED_URL_TTL_SECONDS,
  type DocumentKind,
} from '@/lib/transaction-documents-shared'

type ActionResult = { ok: boolean; error?: string; documentId?: string }

function revalidateAll() {
  revalidatePath('/check-resolution')
  revalidatePath('/vendors/transactions')
  revalidatePath('/admin')
  revalidatePath('/ai-advisor')
  revalidatePath('/')
}

/**
 * Store one scan against a transaction.
 *
 * Every constraint is re-checked here even though the file input also enforces
 * them. The browser only *hints* at accept and size; a form post can claim any
 * type, so type and size are validated server-side where they cannot be edited.
 */
export async function uploadTransactionDocument(
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createClient()

  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return { ok: false, error: 'You need to be signed in to upload.' }

  const transactionId = String(formData.get('transactionId') ?? '')
  const rawKind = String(formData.get('kind') ?? 'other')
  const notes = String(formData.get('notes') ?? '').trim()
  const file = formData.get('file')

  if (!transactionId) return { ok: false, error: 'Missing transaction.' }
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Choose a file to upload.' }
  }

  const kind: DocumentKind = (DOCUMENT_KINDS as readonly string[]).includes(rawKind)
    ? (rawKind as DocumentKind)
    : 'other'

  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return {
      ok: false,
      error: `That file type is not accepted. Use a PNG, JPEG, WEBP, HEIC or PDF.`,
    }
  }

  const maxBytes = await getMaxUploadBytes()
  if (file.size > maxBytes) {
    const mb = (maxBytes / 1024 / 1024).toFixed(0)
    return {
      ok: false,
      error: `That file is larger than the ${mb}MB limit. Raise "Max document upload size" in Settings, or upload a smaller scan.`,
    }
  }

  // Confirm the target exists before writing a file, so a bad id cannot leave an
  // uploaded object with no row pointing at it.
  const { data: txn, error: txnError } = await supabase
    .from('financial_transactions')
    .select('id')
    .eq('id', transactionId)
    .is('deleted_at', null)
    .maybeSingle()

  if (txnError) return { ok: false, error: txnError.message }
  if (!txn) return { ok: false, error: 'That transaction no longer exists.' }

  const storagePath = buildStoragePath(transactionId, file.name)

  const { error: uploadError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false })

  if (uploadError) return { ok: false, error: uploadError.message }

  const { data: inserted, error: insertError } = await supabase
    .from('transaction_documents')
    .insert({
      transaction_id: transactionId,
      storage_path: storagePath,
      file_name: file.name,
      mime_type: file.type,
      file_size_bytes: file.size,
      kind,
      notes: notes || null,
      uploaded_by: auth.user.email ?? null,
    })
    .select('id')
    .single()

  if (insertError) {
    // Roll the object back. Without this a failed insert would leave a file in
    // the bucket that no page can list and nobody can delete.
    await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath])
    return { ok: false, error: insertError.message }
  }

  revalidateAll()
  return { ok: true, documentId: String(inserted.id) }
}

/**
 * Remove an attachment.
 *
 * Soft delete: the row is marked rather than dropped, and the stored file is left
 * in place. A scan of a check is a financial record, so an accidental click must
 * not be the thing that destroys it.
 */
export async function deleteTransactionDocument(
  documentId: string,
): Promise<ActionResult> {
  const supabase = await createClient()

  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return { ok: false, error: 'You need to be signed in.' }

  const { error } = await supabase
    .from('transaction_documents')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', documentId)
    .is('deleted_at', null)

  if (error) return { ok: false, error: error.message }

  revalidateAll()
  return { ok: true }
}

/** Update the kind/notes on an existing attachment. */
export async function updateTransactionDocument(
  documentId: string,
  patch: { kind?: string; notes?: string },
): Promise<ActionResult> {
  const supabase = await createClient()

  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return { ok: false, error: 'You need to be signed in.' }

  const update: Record<string, unknown> = {}
  if (patch.kind && (DOCUMENT_KINDS as readonly string[]).includes(patch.kind)) {
    update.kind = patch.kind
  }
  if (patch.notes !== undefined) update.notes = patch.notes.trim() || null
  if (Object.keys(update).length === 0) return { ok: true }

  const { error } = await supabase
    .from('transaction_documents')
    .update(update)
    .eq('id', documentId)
    .is('deleted_at', null)

  if (error) return { ok: false, error: error.message }

  revalidateAll()
  return { ok: true }
}

/** Mint fresh view links. Signed URLs expire, so the client re-requests them. */
export async function getDocumentViewUrls(
  storagePaths: string[],
): Promise<{ ok: boolean; urls?: Record<string, string>; error?: string }> {
  const supabase = await createClient()

  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return { ok: false, error: 'You need to be signed in.' }
  if (storagePaths.length === 0) return { ok: true, urls: {} }

  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrls(storagePaths, SIGNED_URL_TTL_SECONDS)

  if (error) return { ok: false, error: error.message }

  const urls: Record<string, string> = {}
  for (const item of data ?? []) {
    if (item.signedUrl && item.path) urls[String(item.path)] = item.signedUrl
  }
  return { ok: true, urls }
}
