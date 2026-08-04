'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getTableDef, coerceFieldValue } from '@/lib/admin-config'

const REVALIDATE_PATHS = [
  '/',
  '/cash-flow',
  '/sales',
  '/inventory',
  '/payroll',
  '/vendors',
  '/wholesale',
  '/loans',
  '/cash-debt',
  '/ai-advisor',
  '/admin',
  '/settings',
]

function revalidateAll() {
  for (const p of REVALIDATE_PATHS) revalidatePath(p)
}

async function requireUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  return supabase
}

// Single definition, imported from admin-config so the tested function and the one that
// actually writes to the database cannot drift apart.
const coerce = coerceFieldValue

export async function addRecord(tableKey: string, formData: FormData) {
  const def = getTableDef(tableKey)
  if (!def) return { error: 'Unknown table' }

  try {
    const supabase = await requireUser()
    const row: Record<string, unknown> = {}
    for (const field of def.fields) {
      const raw = formData.get(field.name)
      row[field.name] = coerce(raw as string | null, field.type, field.blankIsNull)
    }
    const { error } = await supabase.from(def.table).insert(row)
    if (error) return { error: error.message }
    revalidateAll()
    return { success: `Added to ${def.label}.` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

export async function updateRecord(tableKey: string, id: string, formData: FormData) {
  const def = getTableDef(tableKey)
  if (!def) return { error: 'Unknown table' }

  try {
    const supabase = await requireUser()
    const row: Record<string, unknown> = {}
    for (const field of def.fields) {
      const raw = formData.get(field.name)
      row[field.name] = coerce(raw as string | null, field.type, field.blankIsNull)
    }
    const { error } = await supabase.from(def.table).update(row).eq('id', id)
    if (error) return { error: error.message }
    revalidateAll()
    return { success: `Updated ${def.label} record.` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

export async function deleteRecord(tableKey: string, id: string) {
  const def = getTableDef(tableKey)
  if (!def) return { error: 'Unknown table' }

  try {
    const supabase = await requireUser()
    // recommendations/most tables use uuid id; kpis uses text key handled elsewhere
    const { error } = await supabase.from(def.table).delete().eq('id', id)
    if (error) return { error: error.message }
    revalidateAll()
    return { success: 'Record deleted.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

/**
 * Mark a receivable or obligation as paid. For receivables we also set the
 * amount paid equal to the full amount so outstanding balances zero out.
 */
export async function markPaid(
  tableKey: 'receivables' | 'cash_obligations',
  id: string,
) {
  try {
    const supabase = await requireUser()
    if (tableKey === 'receivables') {
      const { data: rec } = await supabase
        .from('receivables')
        .select('amount')
        .eq('id', id)
        .single()
      const { error } = await supabase
        .from('receivables')
        .update({ status: 'Paid', amount_paid: rec ? Number(rec.amount) : undefined })
        .eq('id', id)
      if (error) return { error: error.message }
    } else {
      const { error } = await supabase
        .from('cash_obligations')
        .update({ status: 'Paid' })
        .eq('id', id)
      if (error) return { error: error.message }
    }
    revalidateAll()
    return { success: 'Marked as paid.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

/**
 * Save the owner's operating targets from the Settings page. Each setting is
 * upserted by its stable setting_key so the form works whether or not the row
 * already exists.
 */
const SETTING_LABELS: Record<string, { label: string; unit: string }> = {
  target_payroll_pct: { label: 'Target Payroll Percentage', unit: 'percent' },
  warning_payroll_pct: { label: 'Warning Payroll Percentage', unit: 'percent' },
  min_cash_reserve: { label: 'Target Minimum Cash Reserve', unit: 'currency' },
  preferred_weekly_sales: { label: 'Preferred Weekly Sales', unit: 'currency' },
  minimum_weekly_sales: { label: 'Minimum Weekly Sales', unit: 'currency' },
  avg_monthly_wholesale: { label: 'Average Monthly Wholesale Sales', unit: 'currency' },
}

export async function saveBusinessSettings(formData: FormData) {
  try {
    const supabase = await requireUser()

    const rows = Object.entries(SETTING_LABELS)
      .filter(([key]) => formData.get(key) !== null)
      .map(([key, meta]) => ({
        setting_key: key,
        label: meta.label,
        unit: meta.unit,
        value: coerce(formData.get(key) as string | null, 'number'),
      }))

    if (rows.length === 0) return { error: 'Nothing to save.' }

    const { error } = await supabase
      .from('business_settings')
      .upsert(rows, { onConflict: 'setting_key' })
    if (error) return { error: error.message }

    revalidateAll()
    return { success: 'Targets saved.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}

/** Parse a single CSV line respecting quoted fields. */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

export async function importCsv(tableKey: string, formData: FormData) {
  const def = getTableDef(tableKey)
  if (!def) return { error: 'Unknown table' }

  const csv = String(formData.get('csv') ?? '').trim()
  if (!csv) return { error: 'Paste CSV data first.' }

  try {
    const supabase = await requireUser()
    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (lines.length < 2) return { error: 'CSV needs a header row and at least one data row.' }

    const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'))
    const fieldByName = new Map(def.fields.map((f) => [f.name, f]))

    const rows: Record<string, unknown>[] = []
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i])
      const row: Record<string, unknown> = {}
      headers.forEach((h, idx) => {
        const field = fieldByName.get(h)
        if (field)
          row[field.name] = coerce(cells[idx] ?? null, field.type, field.blankIsNull)
      })
      // require at least one required field to be present
      const hasRequired = def.fields
        .filter((f) => f.required)
        .every((f) => row[f.name] !== null && row[f.name] !== undefined && row[f.name] !== '')
      if (Object.keys(row).length > 0 && hasRequired) rows.push(row)
    }

    if (rows.length === 0) {
      return {
        error:
          'No valid rows found. Make sure your header names match the field labels (e.g. ' +
          def.fields.map((f) => f.name).join(', ') +
          ').',
      }
    }

    const { error } = await supabase.from(def.table).insert(rows)
    if (error) return { error: error.message }
    revalidateAll()
    return { success: `Imported ${rows.length} record${rows.length === 1 ? '' : 's'} into ${def.label}.` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong' }
  }
}
