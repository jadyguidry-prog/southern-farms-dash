/**
 * Which sales number wins when several sources describe the same month.
 *
 * The farm can end up with up to four figures for one month: the Square API,
 * a Square CSV export, a number the owner typed, and a figure derived from
 * bank deposits. They will disagree — bank deposits lag and bundle unrelated
 * money, CSV exports are point-in-time, and manual entries are one-offs.
 *
 * Rather than let the last writer win (which silently changes history), every
 * source has a fixed rank and the highest-ranked one available is displayed.
 * A manual entry deliberately outranks Square so the owner can always correct
 * a number, and a `locked` month outranks everything.
 *
 * Pure functions, no DB access, so the precedence rules can be tested directly.
 */

export const SALES_DATA_SOURCES = ['square_api', 'square_csv', 'manual', 'calculated'] as const

export type SalesDataSource = (typeof SALES_DATA_SOURCES)[number]

/**
 * Named constants for the source values, so callers writing rows do not repeat
 * string literals that a typo would turn into an unranked, invisible source.
 */
export const SOURCE_API: SalesDataSource = 'square_api'
export const SOURCE_CSV: SalesDataSource = 'square_csv'
export const SOURCE_MANUAL: SalesDataSource = 'manual'
export const SOURCE_CALCULATED: SalesDataSource = 'calculated'

/**
 * Higher number wins.
 *
 * `manual` sits above the Square feeds on purpose: if the owner has typed a
 * correction, an automated sync must not quietly overwrite it. `calculated`
 * (bank-derived) is the weakest because it is an estimate of sales, not a
 * record of them.
 */
export const SOURCE_RANK: Record<SalesDataSource, number> = {
  manual: 40,
  square_api: 30,
  square_csv: 20,
  calculated: 10,
}

export const SOURCE_LABELS: Record<SalesDataSource, string> = {
  square_api: 'Square (live sync)',
  square_csv: 'Square (CSV import)',
  manual: 'Entered by you',
  calculated: 'Estimated from bank deposits',
}

export const SOURCE_DESCRIPTIONS: Record<SalesDataSource, string> = {
  square_api: 'Pulled directly from your Square account.',
  square_csv: 'Imported from a Square CSV export.',
  manual: 'You typed this figure in, so it overrides the Square feeds.',
  calculated:
    'Inferred from deposits in your bank records. This is an estimate — it can miss cash sales and include money that is not sales revenue.',
}

/** Narrow an unknown string to a known source, or null. */
export function asSalesDataSource(value: string | null | undefined): SalesDataSource | null {
  if (!value) return null
  return (SALES_DATA_SOURCES as readonly string[]).includes(value)
    ? (value as SalesDataSource)
    : null
}

export type SourceCandidate = {
  source: SalesDataSource
  /** Null means "this source has no figure for this month". */
  value: number | null
}

/**
 * Pick the winning candidate.
 *
 * A candidate with a null value is treated as absent — a source that has no
 * data must not beat a lower-ranked source that does, otherwise a configured
 * but empty Square connection would blank out real numbers.
 */
export function resolveWinner(candidates: SourceCandidate[]): SourceCandidate | null {
  const usable = candidates.filter((c) => c.value !== null)
  if (usable.length === 0) return null
  return usable.reduce((best, c) =>
    SOURCE_RANK[c.source] > SOURCE_RANK[best.source] ? c : best,
  )
}

export type MonthSourceInput = {
  locked?: boolean | null
  manual?: number | null
  squareApi?: number | null
  squareCsv?: number | null
  calculated?: number | null
}

export type ResolvedMonth = {
  value: number | null
  source: SalesDataSource | null
  /** True when more than one source has a figure and they disagree. */
  conflict: boolean
  /** Sources that disagree with the winner, for showing an explanation. */
  competing: { source: SalesDataSource; value: number }[]
  locked: boolean
}

/** Two money figures within a cent are the same number. */
function differs(a: number, b: number): boolean {
  return Math.abs(a - b) > 0.01
}

/**
 * Resolve one month's sales figure across all sources.
 *
 * `locked` freezes the manual figure: the owner has declared that month final
 * (typically after filing taxes on it), so no sync may move it.
 */
export function resolveMonthSales(input: MonthSourceInput): ResolvedMonth {
  const locked = Boolean(input.locked)

  const candidates: SourceCandidate[] = [
    { source: 'manual', value: input.manual ?? null },
    { source: 'square_api', value: input.squareApi ?? null },
    { source: 'square_csv', value: input.squareCsv ?? null },
    { source: 'calculated', value: input.calculated ?? null },
  ]

  // A locked month reports its manual figure and ignores everything else.
  if (locked && input.manual != null) {
    const competing = candidates
      .filter((c) => c.source !== 'manual' && c.value !== null)
      .map((c) => ({ source: c.source, value: c.value as number }))
      .filter((c) => differs(c.value, input.manual as number))
    return {
      value: input.manual,
      source: 'manual',
      conflict: competing.length > 0,
      competing,
      locked: true,
    }
  }

  const winner = resolveWinner(candidates)
  if (!winner || winner.value === null) {
    return { value: null, source: null, conflict: false, competing: [], locked }
  }

  const competing = candidates
    .filter((c) => c.source !== winner.source && c.value !== null)
    .map((c) => ({ source: c.source, value: c.value as number }))
    .filter((c) => differs(c.value, winner.value as number))

  return {
    value: winner.value,
    source: winner.source,
    conflict: competing.length > 0,
    competing,
    locked,
  }
}

/**
 * Explain a resolution in one sentence for the UI.
 *
 * Written for a farm owner, not a developer: the point is to answer "why does
 * this number differ from what I expected?" without needing to read code.
 */
export function explainResolution(resolved: ResolvedMonth): string {
  if (!resolved.source || resolved.value === null) {
    return 'No sales figure available for this month from any source.'
  }
  const base = SOURCE_LABELS[resolved.source]
  if (resolved.locked) {
    return `Locked. Showing your entered figure (${base}); syncs will not change it.`
  }
  if (!resolved.conflict) {
    return `From ${base}.`
  }
  const others = resolved.competing
    .map((c) => `${SOURCE_LABELS[c.source]} says ${formatMoney(c.value)}`)
    .join('; ')
  return `From ${base}, which takes priority. ${others}.`
}

function formatMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
