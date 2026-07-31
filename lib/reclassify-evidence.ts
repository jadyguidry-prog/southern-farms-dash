/**
 * Evidence test for "is this row really mis-typed income?"
 *
 * A category label alone is not evidence. `Sales Deposit` was applied by the
 * bank export to two completely different things: real Square payouts arriving
 * in the account, and the monthly Square service fees leaving it. Suggesting
 * "reclassify to income" from the label would have turned recurring fees into
 * retail sales, inventing revenue and erasing a real cost at the same time.
 *
 * So the suggestion is derived from the rows themselves. Pure functions, no DB,
 * so the rules stay verifiable in isolation.
 */

/**
 * One row, reduced to only what the evidence test needs.
 *
 * `direction` is explicit and never inferred from the sign of `amount`. In this
 * database amounts are stored as positive magnitudes and the direction lives in
 * `transaction_type`, so a sign-based guess reported "money arriving" for rows
 * the bank had actually classed as spending. Passing direction in keeps the
 * stated reason truthful.
 */
export type EvidenceRow = {
  /** Magnitude as imported. Sign is ignored; `direction` is authoritative. */
  amount: number
  /** Which way the money moved, taken from the row's transaction type. */
  direction: 'in' | 'out'
  /** ISO date (`YYYY-MM-DD`). */
  date: string
}

export type ReclassifyVerdict =
  /** Evidence supports income — safe to offer reclassification. */
  | 'likely_income'
  /** Evidence contradicts income — offer an expense correction instead. */
  | 'likely_recurring_fee'
  /** Genuinely mixed or too little signal — a human must look. */
  | 'unclear'

export type EvidenceReport = {
  verdict: ReclassifyVerdict
  /** Plain-language reasons, shown verbatim in the UI. */
  reasons: string[]
  /** True when the owner must override before any reclassification is allowed. */
  blocksReclassification: boolean
  rowCount: number
  /** Distinct amounts that repeat in 3+ separate months, largest first. */
  recurringAmounts: { amount: number; monthCount: number }[]
  /** Share of rows that are outflows (0-1). */
  outflowShare: number
  /** Mean absolute amount. */
  averageAmount: number
  /** Distinct `YYYY-MM` months covered. */
  monthCount: number
  /** Share of rows falling in the first 5 days of a month (0-1). */
  earlyMonthShare: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * A fixed amount landing in at least 3 distinct months is a subscription
 * signature. Sales vary; a service fee does not.
 */
const RECURRING_MIN_MONTHS = 3

function monthOf(date: string): string {
  return (date ?? '').slice(0, 7)
}

function dayOf(date: string): number {
  const d = Number((date ?? '').slice(8, 10))
  return Number.isFinite(d) ? d : 0
}

/**
 * Weigh the rows and decide whether "this is really income" is supportable.
 *
 * Deliberately conservative: absent positive evidence of income the answer is
 * `unclear`, never a guess. Being told "look at this yourself" costs the owner a
 * minute; a wrong reclassification silently corrupts revenue and cost at once.
 */
export function assessReclassification(rows: EvidenceRow[]): EvidenceReport {
  const rowCount = rows.length
  if (rowCount === 0) {
    return {
      verdict: 'unclear',
      reasons: ['No rows to examine.'],
      blocksReclassification: true,
      rowCount: 0,
      recurringAmounts: [],
      outflowShare: 0,
      averageAmount: 0,
      monthCount: 0,
      earlyMonthShare: 0,
    }
  }

  const outflows = rows.filter((r) => r.direction === 'out').length
  const outflowShare = outflows / rowCount
  const averageAmount = round2(
    rows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0) / rowCount,
  )

  const months = new Set<string>()
  for (const r of rows) {
    const m = monthOf(r.date)
    if (m) months.add(m)
  }

  const earlyMonth = rows.filter((r) => {
    const d = dayOf(r.date)
    return d >= 1 && d <= 5
  }).length
  const earlyMonthShare = earlyMonth / rowCount

  // Group by exact absolute amount and count the distinct months each appears in.
  const byAmount = new Map<number, Set<string>>()
  for (const r of rows) {
    const key = round2(Math.abs(Number(r.amount) || 0))
    const set = byAmount.get(key) ?? new Set<string>()
    const m = monthOf(r.date)
    if (m) set.add(m)
    byAmount.set(key, set)
  }
  const recurringAmounts = [...byAmount.entries()]
    .filter(([, ms]) => ms.size >= RECURRING_MIN_MONTHS)
    .map(([amount, ms]) => ({ amount, monthCount: ms.size }))
    .sort((a, b) => b.monthCount - a.monthCount || b.amount - a.amount)

  const reasons: string[] = []
  let verdict: ReclassifyVerdict = 'unclear'

  const mostlyOutflow = outflowShare >= 0.9
  const hasRecurring = recurringAmounts.length > 0
  const mostlyEarlyMonth = earlyMonthShare >= 0.8

  if (mostlyOutflow) {
    reasons.push(
      rowCount === outflows
        ? `All ${rowCount} rows were imported as spending.`
        : `${outflows} of ${rowCount} rows were imported as spending.`,
    )
  } else if (outflowShare <= 0.1) {
    reasons.push(
      `${rowCount - outflows} of ${rowCount} rows were imported as money coming in.`,
    )
  } else {
    reasons.push(
      `Mixed directions: ${outflows} out, ${rowCount - outflows} in. These are probably not all the same kind of transaction.`,
    )
  }

  if (hasRecurring) {
    const top = recurringAmounts.slice(0, 3)
    reasons.push(
      `Fixed amounts repeat monthly: ${top
        .map((t) => `$${t.amount.toFixed(2)} in ${t.monthCount} months`)
        .join(', ')}. Sales vary month to month; a subscription or service fee does not.`,
    )
  }

  if (mostlyEarlyMonth && months.size >= RECURRING_MIN_MONTHS) {
    reasons.push(
      `${Math.round(earlyMonthShare * 100)}% land in the first 5 days of the month, which is a billing-cycle pattern.`,
    )
  }

  // Outflow + a repeating fixed amount is the fee signature. Either alone is not
  // enough: a one-off refund is an outflow, and a fixed retainer paid TO the farm
  // repeats while still being income.
  if (mostlyOutflow && (hasRecurring || mostlyEarlyMonth)) {
    verdict = 'likely_recurring_fee'
    reasons.push(
      'Treating these as income would add revenue that never arrived and remove a cost that was really paid.',
    )
  } else if (outflowShare <= 0.1 && !hasRecurring) {
    verdict = 'likely_income'
    reasons.push('Direction and variability are both consistent with real income.')
  } else {
    verdict = 'unclear'
    reasons.push(
      'The evidence does not clearly support either answer. Check a statement before deciding.',
    )
  }

  return {
    verdict,
    reasons,
    // Only a positive income verdict may be reclassified without an override.
    blocksReclassification: verdict !== 'likely_income',
    rowCount,
    recurringAmounts,
    outflowShare: round2(outflowShare),
    averageAmount,
    monthCount: months.size,
    earlyMonthShare: round2(earlyMonthShare),
  }
}

/**
 * Tokens that are reference numbers rather than a merchant name. Bank exports
 * append a per-transaction id ("SQ250501", "T3YF62329G8PNS9"), which makes every
 * description unique — so the shared merchant only appears after dropping them.
 */
function isReferenceToken(token: string): boolean {
  if (/\d/.test(token)) return true // any token carrying digits is an id/date
  if (token.length <= 1) return true
  return false
}

/** Corporate suffixes that add nothing to a category name. */
const CORPORATE_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'company'])

/**
 * Derive the merchant shared by a group of descriptions.
 *
 * Used to name the corrective expense category, so the owner is offered
 * "Square — Fees" rather than a hardcoded guess. Requires the SAME leading words
 * in effectively every row: a mixed group has no single merchant, and inventing
 * one would put unrelated spending under a confident-looking label.
 *
 * Returns `null` unless the agreement is near-unanimous.
 */
export function deriveMerchantName(descriptions: string[]): string | null {
  const tokenised = descriptions
    .map((d) =>
      (d ?? '')
        .split(/[\s/]+/)
        .map((t) => t.replace(/[^A-Za-z0-9&]/g, ''))
        .filter((t) => t.length > 0 && !isReferenceToken(t)),
    )
    .filter((t) => t.length > 0)

  if (tokenised.length === 0) return null
  // Require agreement across ~90% of rows so a stray row cannot set the name.
  if (tokenised.length < descriptions.length * 0.9) return null

  const first = tokenised[0]
  const words: string[] = []
  for (let i = 0; i < first.length && i < 3; i += 1) {
    const word = first[i].toLowerCase()
    if (!tokenised.every((t) => (t[i] ?? '').toLowerCase() === word)) break
    words.push(first[i])
  }

  // Drop trailing corporate suffixes, but never return an empty name.
  while (
    words.length > 1 &&
    CORPORATE_SUFFIXES.has(words[words.length - 1].toLowerCase())
  ) {
    words.pop()
  }
  if (words.length === 0) return null

  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}
