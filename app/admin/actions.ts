'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getTableDef } from '@/lib/admin-config'

const REVALIDATE_PATHS = [
  '/',
  '/cash-flow',
  '/sales',
  '/inventory',
  '/payroll',
  '/vendors',
  '/wholesale',
  '/loans',
  '/ai-advisor',
  '/admin',
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

/** Coerce a raw string value to the correct JS type for its column. */
function coerce(value: string | null, type: string) {
  if (value == null || value === '') return type === 'number' ? 0 : null
  if (type === 'number') {
    const n = Number(String(value).replace(/[$,%\s]/g, ''))
    return Number.isFinite(n) ? n : 0
  }
  return value
}

export async function addRecord(tableKey: string, formData: FormData) {
  const def = getTableDef(tableKey)
  if (!def) return { error: 'Unknown table' }

  try {
    const supabase = await requireUser()
    const row: Record<string, unknown> = {}
    for (const field of def.fields) {
      const raw = formData.get(field.name)
      row[field.name] = coerce(raw as string | null, field.type)
    }
    const { error } = await supabase.from(def.table).insert(row)
    if (error) return { error: error.message }
    revalidateAll()
    return { success: `Added to ${def.label}.` }
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
        if (field) row[field.name] = coerce(cells[idx] ?? null, field.type)
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
