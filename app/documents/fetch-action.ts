'use server'

import { createClient } from '@/lib/supabase/server'
import {
  mapDocumentRow,
  type TransactionDocument,
} from '@/lib/transaction-documents-shared'

/**
 * Attachments for one transaction, fetched on demand.
 *
 * Loaded per-dialog rather than with the page because the check list renders up
 * to 60 rows: eagerly joining every attachment would cost a query the owner
 * mostly does not need, and signed view links expire anyway. The list only needs
 * a count badge, which arrives with the page.
 */
export async function fetchTransactionDocuments(
  transactionId: string,
): Promise<{ ok: boolean; documents?: TransactionDocument[]; error?: string }> {
  const supabase = await createClient()

  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return { ok: false, error: 'You need to be signed in.' }

  const { data, error } = await supabase
    .from('transaction_documents')
    .select('*')
    .eq('transaction_id', transactionId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })

  if (error) return { ok: false, error: error.message }

  const documents: TransactionDocument[] = (data ?? []).map(mapDocumentRow)

  return { ok: true, documents }
}
