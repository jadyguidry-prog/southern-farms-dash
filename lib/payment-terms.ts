/**
 * Payment terms — the single source of truth for what "Net 21" means.
 *
 * This module is PURE and client-safe (no DB, no clock, no server imports) so the vendor
 * form, the bill form and the due-date resolver all read the SAME mapping. When the label
 * list and the numeric mapping live in two files they drift, and a vendor set to "Net 21"
 * silently computes a 30-day due date.
 *
 * Terms answer one question: given the date the vendor billed us, when is payment due?
 *   due date = invoice date + net days
 */

/**
 * The selectable terms, in ascending order of how long we get to pay.
 *
 * `days: null` means the term implies no derivable due date, which is NOT the same as 0:
 *   - 'Due on Receipt' is 0 days — a real, same-day deadline.
 *   - 'Prepaid' is null — paid before delivery, so there is no receivable clock at all.
 * Collapsing those two would turn every prepaid vendor into a bill due the instant it is
 * entered, manufacturing overdue debt that does not exist.
 */
export const PAYMENT_TERM_OPTIONS: readonly { label: string; days: number | null }[] = [
  { label: 'Prepaid', days: null },
  { label: 'Due on Receipt', days: 0 },
  { label: 'Net 7', days: 7 },
  { label: 'Net 10', days: 10 },
  { label: 'Net 14', days: 14 },
  { label: 'Net 15', days: 15 },
  // Net 21 — Sysco's terms as of Aug 2026. Added because the owner was told over the
  // phone; there is no import that would have produced it.
  { label: 'Net 21', days: 21 },
  { label: 'Net 30', days: 30 },
  { label: 'Net 45', days: 45 },
  { label: 'Net 60', days: 60 },
  { label: 'Net 90', days: 90 },
]

/** Just the labels, for a <select>. */
export const PAYMENT_TERM_LABELS: readonly string[] = PAYMENT_TERM_OPTIONS.map(
  (t) => t.label,
)

/**
 * Label -> net days. Returns `null` for Prepaid, unknown labels, and blanks alike,
 * because in every one of those cases we cannot derive a due date and must fall back to
 * whatever date was entered by hand.
 *
 * Also accepts a bare number or a numeric string ("21"), so a value that has already been
 * normalised round-trips instead of being lost.
 */
export function termsToDays(terms: string | number | null | undefined): number | null {
  if (terms == null || terms === '') return null
  if (typeof terms === 'number') return Number.isFinite(terms) && terms >= 0 ? terms : null

  const trimmed = terms.trim()
  if (trimmed === '') return null

  const exact = PAYMENT_TERM_OPTIONS.find(
    (t) => t.label.toLowerCase() === trimmed.toLowerCase(),
  )
  if (exact) return exact.days

  // Tolerate free-text variants that mean the same thing: "net21", "NET 21", "21 days",
  // or a plain "21". Historical rows were typed by hand, so a strict match would quietly
  // treat a real term as "not specified".
  const m = trimmed.match(/^(?:net\s*)?(\d{1,3})(?:\s*days?)?$/i)
  if (m) {
    const n = Number(m[1])
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Net days -> the canonical label, so a stored 21 displays as "Net 21" rather than a bare
 * number. Falls back to "Net N" for a value with no matching option (e.g. an imported 37)
 * instead of hiding it.
 */
export function daysToTermsLabel(days: number | null | undefined): string | null {
  if (days == null || !Number.isFinite(days) || days < 0) return null
  const match = PAYMENT_TERM_OPTIONS.find((t) => t.days === days)
  return match ? match.label : `Net ${days}`
}

/**
 * Add whole days to a "YYYY-MM-DD" date and return the same format.
 *
 * Parsed at local midnight and read back off LOCAL fields. `toISOString()` would convert
 * to UTC first and report the previous day in any positive-offset timezone — every date
 * here is a plain calendar day, so it must never round-trip through UTC.
 */
export function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return ''
  d.setDate(d.getDate() + days)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * The derived due date for an invoice, or '' when it cannot be derived.
 *
 * Requires BOTH an invoice date and a numeric term. Missing either one returns '' so the
 * caller falls back to the hand-entered due date — deriving from a guess would overwrite
 * a real deadline with a fabricated one.
 */
export function deriveDueDate(
  invoiceDate: string | null | undefined,
  termsDays: number | null | undefined,
): string {
  if (!invoiceDate) return ''
  if (termsDays == null || !Number.isFinite(termsDays) || termsDays < 0) return ''
  return addDaysISO(invoiceDate, termsDays)
}
