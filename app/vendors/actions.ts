'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { termsToDays } from '@/lib/payment-terms'

async function requireUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  return supabase
}

function revalidateVendors(id?: string) {
  revalidatePath('/vendors')
  revalidatePath('/')
  revalidatePath('/admin')
  if (id) revalidatePath(`/vendors/${id}`)
}

/** Read a trimmed string field, returning null when blank so the column stays empty. */
function text(formData: FormData, key: string): string | null {
  const raw = formData.get(key)
  if (raw == null) return null
  const value = String(raw).trim()
  return value === '' ? null : value
}

const EDITABLE_FIELDS = [
  'display_name',
  'category',
  'vendor_type',
  'vendor_status',
  'phone',
  'email',
  'website',
  'billing_address',
  'shipping_address',
  'payment_terms',
  'preferred_payment_method',
  'notes',
] as const

function collectFields(formData: FormData) {
  const row: Record<string, unknown> = {}
  for (const field of EDITABLE_FIELDS) {
    // Only touch fields the submitted form actually contains.
    if (formData.get(field) !== null) row[field] = text(formData, field)
  }
  if (formData.get('recurring') !== null) {
    row.recurring = formData.get('recurring') === 'true'
  }
  if (formData.get('requires_1099') !== null) {
    row.requires_1099 = formData.get('requires_1099') === 'true'
  }
  // Keep the numeric terms in lockstep with the label, DERIVED rather than entered
  // separately. Two independent inputs for one fact drift, and here that drift would be
  // invisible: the vendor would read "Net 21" while every due date computed at 30 days.
  // termsToDays returns null for Prepaid and for anything unrecognised, which correctly
  // records "no derivable due date" instead of guessing one.
  if (formData.get('payment_terms') !== null) {
    row.payment_terms_days = termsToDays(text(formData, 'payment_terms'))
  }
  return row
}

/**
 * Generate the next sequential vendor number (V-016, V-017, ...) based on the
 * highest existing value, so numbers stay unique without a separate sequence.
 */
async function nextVendorNumber(
  supabase: Awaited<ReturnType<typeof createClient>>,
) {
  const { data } = await supabase
    .from('vendors')
    .select('vendor_number')
    .not('vendor_number', 'is', null)

  let max = 0
  for (const row of data ?? []) {
    const match = /^V-(\d+)$/.exec(String(row.vendor_number))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `V-${String(max + 1).padStart(3, '0')}`
}

export async function createVendor(formData: FormData) {
  const name = text(formData, 'name')
  if (!name) return { error: 'Vendor name is required.' }

  try {
    const supabase = await requireUser()

    // Guard against accidentally creating a second record for the same vendor.
    const { data: existing } = await supabase
      .from('vendors')
      .select('id')
      .ilike('name', name)
      .is('deleted_at', null)
      .maybeSingle()
    if (existing) return { error: `A vendor named "${name}" already exists.` }

    const row = {
      ...collectFields(formData),
      name,
      vendor_number: text(formData, 'vendor_number') ?? (await nextVendorNumber(supabase)),
      vendor_status: text(formData, 'vendor_status') ?? 'Active',
    }

    const { error } = await supabase.from('vendors').insert(row)
    if (error) return { error: error.message }

    revalidateVendors()
    return { success: `${name} added to the vendor directory.` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

export async function updateVendor(id: string, formData: FormData) {
  const name = text(formData, 'name')
  if (!name) return { error: 'Vendor name is required.' }

  try {
    const supabase = await requireUser()
    const row = { ...collectFields(formData), name }
    const { error } = await supabase.from('vendors').update(row).eq('id', id)
    if (error) return { error: error.message }

    revalidateVendors(id)
    return { success: `${name} updated.` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

/**
 * Archive or restore a vendor. Archiving keeps all history and payables intact
 * but hides the vendor from the default directory view.
 */
export async function setVendorArchived(id: string, archived: boolean) {
  try {
    const supabase = await requireUser()
    const { error } = await supabase
      .from('vendors')
      .update({
        archived_at: archived ? new Date().toISOString() : null,
        vendor_status: archived ? 'Inactive' : 'Active',
      })
      .eq('id', id)
    if (error) return { error: error.message }

    revalidateVendors(id)
    return { success: archived ? 'Vendor archived.' : 'Vendor restored.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

/**
 * Soft delete. The row is retained so historical payables and reporting keep
 * their vendor reference; it simply stops appearing anywhere in the UI.
 */
export async function deleteVendor(id: string) {
  try {
    const supabase = await requireUser()
    const { error } = await supabase
      .from('vendors')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
    if (error) return { error: error.message }

    revalidateVendors(id)
    return { success: 'Vendor removed from the directory.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

export async function addVendorContact(vendorId: string, formData: FormData) {
  const name = text(formData, 'contact_name')
  if (!name) return { error: 'Contact name is required.' }

  try {
    const supabase = await requireUser()
    const { error } = await supabase.from('vendor_contacts').insert({
      vendor_id: vendorId,
      name,
      title: text(formData, 'contact_title'),
      phone: text(formData, 'contact_phone'),
      email: text(formData, 'contact_email'),
    })
    if (error) return { error: error.message }

    revalidateVendors(vendorId)
    return { success: `${name} added as a contact.` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

export async function deleteVendorContact(vendorId: string, contactId: string) {
  try {
    const supabase = await requireUser()
    const { error } = await supabase
      .from('vendor_contacts')
      .delete()
      .eq('id', contactId)
    if (error) return { error: error.message }

    revalidateVendors(vendorId)
    return { success: 'Contact removed.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

export async function addVendorDocument(vendorId: string, formData: FormData) {
  const documentName = text(formData, 'document_name')
  if (!documentName) return { error: 'Document name is required.' }

  try {
    const supabase = await requireUser()
    const { error } = await supabase.from('vendor_documents').insert({
      vendor_id: vendorId,
      document_name: documentName,
      document_type: text(formData, 'document_type'),
      file_url: text(formData, 'file_url'),
    })
    if (error) return { error: error.message }

    revalidateVendors(vendorId)
    return { success: `${documentName} recorded.` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

export async function deleteVendorDocument(vendorId: string, documentId: string) {
  try {
    const supabase = await requireUser()
    const { error } = await supabase
      .from('vendor_documents')
      .delete()
      .eq('id', documentId)
    if (error) return { error: error.message }

    revalidateVendors(vendorId)
    return { success: 'Document removed.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}
