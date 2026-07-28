/**
 * Square CSV report parsing — pure functions, no database access.
 *
 * Square's dashboard exports several different reports and the exact headers
 * drift between report types and over time ("Net Sales" vs "Net sales",
 * "Qty" vs "Quantity", "$1,234.56" vs "1234.56" vs "(12.00)" for negatives).
 * Everything here is therefore tolerant on input and strict on output: we
 * normalise headers aggressively, and any row we cannot read confidently is
 * returned as a rejected row with a human-readable reason rather than being
 * silently coerced to zero.
 *
 * Kept DB-free so it can be unit tested directly.
 */

export type SquareCsvReportType = 'daily' | 'items'

export type CsvRow = Record<string, string>

/** A parsed daily-sales row, in DOLLARS. */
export type ParsedDailyRow = {
  rowNumber: number
  saleDate: string // YYYY-MM-DD
  grossSales: number
  netSales: number
  discounts: number
  refunds: number
  taxes: number
  tips: number
  fees: number
  transactionCount: number
}

/** A parsed item/category row, in DOLLARS. */
export type ParsedItemRow = {
  rowNumber: number
  itemName: string
  categoryName: string | null
  units: number
  grossSales: number
  netSales: number
  discounts: number
  periodStart: string | null
  periodEnd: string | null
}

export type RejectedRow = {
  rowNumber: number
  reason: string
  raw: CsvRow
}

export type ParseResult<T> = {
  reportType: SquareCsvReportType
  rows: T[]
  rejected: RejectedRow[]
  /** Headers we recognised, for showing the user what we matched. */
  matched: Record<string, string>
  /** Headers present in the file that we ignored. */
  ignored: string[]
}

/* ------------------------------------------------------------------ */
/* Header matching                                                     */
/* ------------------------------------------------------------------ */

/**
 * Normalise a header for comparison: lowercase, strip punctuation and
 * whitespace. "Net Sales ($)" and "net_sales" both become "netsales".
 */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/\(.*?\)/g, '') // drop parenthetical units like "($)"
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Candidate header names per logical field, in priority order. The first
 * matching header in the file wins, so more specific names come first.
 */
const HEADER_CANDIDATES: Record<string, string[]> = {
  date: ['date', 'saledate', 'day', 'datetime', 'transactiondate', 'createdat'],
  grossSales: ['grosssales', 'gross', 'toplineproductsales', 'grossamount', 'itemsales'],
  netSales: ['netsales', 'net', 'nettotal', 'netamount'],
  discounts: ['discounts', 'discount', 'discountsamount', 'totaldiscounts'],
  refunds: ['refunds', 'refund', 'refundsamount', 'returns', 'refundedamount'],
  taxes: ['tax', 'taxes', 'salestax', 'salestaxamount', 'taxamount'],
  tips: ['tips', 'tip', 'tipsamount'],
  fees: ['fees', 'fee', 'squarefees', 'processingfees', 'feeamount'],
  transactionCount: ['transactions', 'transactioncount', 'count', 'orders', 'ordercount', 'sales'],
  item: ['item', 'itemname', 'productname', 'product', 'name'],
  category: ['category', 'categoryname', 'itemcategory', 'reportingcategory'],
  units: ['qty', 'quantity', 'itemsold', 'itemssold', 'unitssold', 'units', 'count'],
}

/**
 * Match the file's headers to our logical fields.
 * Returns a map of logicalField -> actual header string.
 */
export function matchHeaders(headers: string[]): Record<string, string> {
  const normalizedToOriginal = new Map<string, string>()
  for (const h of headers) {
    const n = normalizeHeader(h)
    // First occurrence wins so a later duplicate column can't shadow it.
    if (n && !normalizedToOriginal.has(n)) normalizedToOriginal.set(n, h)
  }

  const matched: Record<string, string> = {}
  const claimed = new Set<string>()

  for (const [field, candidates] of Object.entries(HEADER_CANDIDATES)) {
    for (const candidate of candidates) {
      const original = normalizedToOriginal.get(candidate)
      if (original && !claimed.has(original)) {
        matched[field] = original
        claimed.add(original)
        break
      }
    }
  }

  return matched
}

/**
 * Decide which report a file is. A file with an item column but no usable
 * date column is an items report; anything with a date is a daily report.
 * `date` alone is not enough to rule out items, because Square's item
 * exports sometimes carry the report period in a date column.
 */
export function detectReportType(headers: string[]): SquareCsvReportType | null {
  const matched = matchHeaders(headers)
  const hasMoney = Boolean(matched.grossSales || matched.netSales)
  if (!hasMoney) return null
  if (matched.item && !matched.date) return 'items'
  if (matched.date) return 'daily'
  if (matched.item) return 'items'
  return null
}

/* ------------------------------------------------------------------ */
/* Value parsing                                                       */
/* ------------------------------------------------------------------ */

/**
 * Parse a Square money string into a number of dollars.
 * Handles "$1,234.56", "1234.56", "-$5.00", "($5.00)" (accounting negative),
 * "" and "—" (both null). Returns null when the value isn't a number, so the
 * caller can decide between "absent" and "zero" rather than guessing.
 */
export function parseMoney(value: string | undefined | null): number | null {
  if (value == null) return null
  let s = String(value).trim()
  if (s === '' || s === '-' || s === '—' || s === '–' || s.toUpperCase() === 'N/A') return null

  // Accounting-style negatives: ($5.00)
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }

  s = s.replace(/[$\s,]/g, '')
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  }
  if (s === '') return null
  if (!/^\d*\.?\d+$/.test(s)) return null

  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

/** Parse an integer count. Returns null when unreadable. */
export function parseCount(value: string | undefined | null): number | null {
  if (value == null) return null
  const s = String(value).trim().replace(/[,\s]/g, '')
  if (s === '') return null
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return Math.round(n)
}

/**
 * Parse a Square date cell to YYYY-MM-DD.
 *
 * Deliberately does NOT use `new Date(string)`: that applies the server's
 * timezone and can shift a date across a day (and therefore a month)
 * boundary. We parse the components textually instead. Ambiguous
 * DD/MM vs MM/DD is resolved as US-style MM/DD, matching Square's US
 * dashboard exports, unless the first part is clearly > 12.
 */
export function parseCsvDate(value: string | undefined | null): string | null {
  if (value == null) return null
  const s = String(value).trim()
  if (s === '') return null

  // Strip a trailing time component if present.
  const datePart = s.split(/[T\s]/)[0]

  // ISO: YYYY-MM-DD
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(datePart)
  if (m) {
    const [, y, mo, d] = m
    return isoDate(Number(y), Number(mo), Number(d))
  }

  // Slash or dot separated: M/D/YYYY or D/M/YYYY or M/D/YY
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/.exec(datePart)
  if (m) {
    let first = Number(m[1])
    let second = Number(m[2])
    let year = Number(m[3])
    if (m[3].length === 2) year += year < 70 ? 2000 : 1900
    // If the first component can't be a month, it must be the day.
    if (first > 12 && second <= 12) {
      const tmp = first
      first = second
      second = tmp
    }
    return isoDate(year, first, second)
  }

  // "Jan 5, 2026" / "5 Jan 2026"
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  }
  m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(datePart.length ? s.trim() : '')
  if (m) {
    const mo = months[m[1].slice(0, 3).toLowerCase()]
    if (mo) return isoDate(Number(m[3]), mo, Number(m[2]))
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(s.trim())
  if (m) {
    const mo = months[m[2].slice(0, 3).toLowerCase()]
    if (mo) return isoDate(Number(m[3]), mo, Number(m[1]))
  }

  return null
}

function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (year < 1900 || year > 2200) return null
  // Reject impossible days (e.g. Feb 30) by round-tripping through UTC.
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null
  }
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

/* ------------------------------------------------------------------ */
/* Row parsing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Square item reports include summary rows ("Total", "Grand Total") that
 * would double-count if imported as items.
 */
export function isTotalsRow(row: CsvRow): boolean {
  const values = Object.values(row).map((v) => String(v ?? '').trim().toLowerCase())
  return values.some(
    (v) => v === 'total' || v === 'totals' || v === 'grand total' || v === 'subtotal',
  )
}

/** Parse a daily-sales report. Money out in dollars. */
export function parseDailyReport(
  headers: string[],
  rows: CsvRow[],
): ParseResult<ParsedDailyRow> {
  const matched = matchHeaders(headers)
  const claimed = new Set(Object.values(matched))
  const ignored = headers.filter((h) => !claimed.has(h))

  const out: ParsedDailyRow[] = []
  const rejected: RejectedRow[] = []
  // Track dates so the same day appearing twice in one file is reported
  // rather than silently overwriting.
  const seenDates = new Map<string, number>()

  rows.forEach((row, i) => {
    const rowNumber = i + 2 // +1 for header, +1 for 1-based

    if (isTotalsRow(row)) {
      rejected.push({ rowNumber, reason: 'Summary/total row — skipped', raw: row })
      return
    }

    const dateRaw = matched.date ? row[matched.date] : undefined
    const saleDate = parseCsvDate(dateRaw)
    if (!saleDate) {
      rejected.push({
        rowNumber,
        reason: dateRaw ? `Unreadable date "${dateRaw}"` : 'Missing date',
        raw: row,
      })
      return
    }

    const gross = matched.grossSales ? parseMoney(row[matched.grossSales]) : null
    const net = matched.netSales ? parseMoney(row[matched.netSales]) : null
    if (gross === null && net === null) {
      rejected.push({ rowNumber, reason: 'No readable sales amount', raw: row })
      return
    }

    const discounts = Math.abs(
      (matched.discounts ? parseMoney(row[matched.discounts]) : null) ?? 0,
    )
    const refunds = Math.abs((matched.refunds ? parseMoney(row[matched.refunds]) : null) ?? 0)
    const taxes = (matched.taxes ? parseMoney(row[matched.taxes]) : null) ?? 0
    const tips = (matched.tips ? parseMoney(row[matched.tips]) : null) ?? 0
    const fees = Math.abs((matched.fees ? parseMoney(row[matched.fees]) : null) ?? 0)
    const count = (matched.transactionCount ? parseCount(row[matched.transactionCount]) : null) ?? 0

    // Derive whichever of gross/net is absent so downstream code always has
    // both. Net = gross - discounts - refunds when Square didn't supply it.
    const grossFinal = gross ?? (net as number) + discounts + refunds
    const netFinal = net ?? (gross as number) - discounts - refunds

    if (seenDates.has(saleDate)) {
      rejected.push({
        rowNumber,
        reason: `Duplicate date ${saleDate} (already on row ${seenDates.get(saleDate)})`,
        raw: row,
      })
      return
    }
    seenDates.set(saleDate, rowNumber)

    out.push({
      rowNumber,
      saleDate,
      grossSales: round2(grossFinal),
      netSales: round2(netFinal),
      discounts: round2(discounts),
      refunds: round2(refunds),
      taxes: round2(taxes),
      tips: round2(tips),
      fees: round2(fees),
      transactionCount: count,
    })
  })

  return { reportType: 'daily', rows: out, rejected, matched, ignored }
}

/** Parse an item/category report. Money out in dollars. */
export function parseItemsReport(
  headers: string[],
  rows: CsvRow[],
  period?: { start: string | null; end: string | null },
): ParseResult<ParsedItemRow> {
  const matched = matchHeaders(headers)
  const claimed = new Set(Object.values(matched))
  const ignored = headers.filter((h) => !claimed.has(h))

  const out: ParsedItemRow[] = []
  const rejected: RejectedRow[] = []

  rows.forEach((row, i) => {
    const rowNumber = i + 2

    if (isTotalsRow(row)) {
      rejected.push({ rowNumber, reason: 'Summary/total row — skipped', raw: row })
      return
    }

    const itemName = matched.item ? String(row[matched.item] ?? '').trim() : ''
    if (!itemName) {
      rejected.push({ rowNumber, reason: 'Missing item name', raw: row })
      return
    }

    const gross = matched.grossSales ? parseMoney(row[matched.grossSales]) : null
    const net = matched.netSales ? parseMoney(row[matched.netSales]) : null
    if (gross === null && net === null) {
      rejected.push({ rowNumber, reason: 'No readable sales amount', raw: row })
      return
    }

    const discounts = Math.abs(
      (matched.discounts ? parseMoney(row[matched.discounts]) : null) ?? 0,
    )
    const units = (matched.units ? parseCount(row[matched.units]) : null) ?? 0
    const categoryName = matched.category
      ? String(row[matched.category] ?? '').trim() || null
      : null

    const grossFinal = gross ?? (net as number) + discounts
    const netFinal = net ?? (gross as number) - discounts

    out.push({
      rowNumber,
      itemName,
      categoryName,
      units,
      grossSales: round2(grossFinal),
      netSales: round2(netFinal),
      discounts: round2(discounts),
      periodStart: period?.start ?? null,
      periodEnd: period?.end ?? null,
    })
  })

  return { reportType: 'items', rows: out, rejected, matched, ignored }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Summarise a parse for the confirmation screen. */
export function summarizeDaily(rows: ParsedDailyRow[]) {
  const totalGross = rows.reduce((s, r) => s + r.grossSales, 0)
  const totalNet = rows.reduce((s, r) => s + r.netSales, 0)
  const dates = rows.map((r) => r.saleDate).sort()
  return {
    rowCount: rows.length,
    totalGross: round2(totalGross),
    totalNet: round2(totalNet),
    periodStart: dates[0] ?? null,
    periodEnd: dates[dates.length - 1] ?? null,
  }
}

/** Summarise an items parse for the confirmation screen. */
export function summarizeItems(rows: ParsedItemRow[]) {
  const totalGross = rows.reduce((s, r) => s + r.grossSales, 0)
  const categories = new Set(rows.map((r) => r.categoryName).filter(Boolean))
  return {
    rowCount: rows.length,
    totalGross: round2(totalGross),
    categoryCount: categories.size,
  }
}
