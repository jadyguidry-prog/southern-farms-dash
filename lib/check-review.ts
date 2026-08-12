// Pure helpers for the manual CHECK review queue.
//
// `CHECK # 1317` lines carry a check number but no payee — the bank export
// never recorded who was paid. No rule can infer the recipient from the text,
// so these must be reviewed by hand. What we CAN do is surface the strongest
// signals (repeating amounts, sequential numbers) so the owner recognises a
// batch at a glance instead of opening 196 rows one by one.
//
// DB-free so the grouping logic is unit tested without a database.

/**
 * Extract the check number embedded in a raw description such as
 * "CHECK # 1317" or "CHECK 001042". Returns the digits as a string (leading
 * zeros preserved) or null when the line is a bare `CHECK` with no number.
 */
export function parseCheckNumber(description: string): string | null {
  if (!description) return null
  const m = /^\s*CHECK\b[^0-9]*#?\s*(\d{2,})/i.exec(description)
  return m ? m[1] : null
}

export type CheckRow = {
  id: string
  transactionDate: string
  amount: number
  checkNumber: string | null
  description: string
  accountName: string
  expenseCategory: string
  vendorId: string | null
  reviewStatus: string
}

export type CheckAmountCluster = {
  /** Absolute amount shared by every check in the cluster, to the cent. */
  amount: number
  count: number
  total: number
  checkNumbers: string[]
  transactionIds: string[]
  firstDate: string
  lastDate: string
  /** A cluster of identical amounts is a strong recurring-payee signal. */
  looksRecurring: boolean
}

export type CheckReviewSummary = {
  totalChecks: number
  totalAmount: number
  /** Checks that carry a parseable number. */
  numberedCount: number
  /** Bare `CHECK` lines with no number at all. */
  bareCount: number
  /** Lowest / highest check number seen, for a quick "are any missing" glance. */
  numberRange: { min: string; max: string } | null
  /** Repeating-amount clusters, ranked by dollars, that hint at one payee. */
  amountClusters: CheckAmountCluster[]
  /** Checks already assigned a payee or category, so progress is visible. */
  reviewedCount: number
}

function cents(amount: number): number {
  return Math.round(Math.abs(Number(amount) || 0) * 100)
}

/**
 * Summarise a set of CHECK rows for the review queue.
 *
 * `minClusterSize` guards against calling two coincidental same-amount checks a
 * "recurring payee": a cluster is only surfaced as recurring at 3+, matching the
 * threshold used by `analyzeRecurring`.
 */
export function summarizeChecks(
  rows: CheckRow[],
  { minClusterSize = 2, recurringThreshold = 3 }: {
    minClusterSize?: number
    recurringThreshold?: number
  } = {},
): CheckReviewSummary {
  const totalAmount = rows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0)
  const numbered = rows.filter((r) => r.checkNumber)
  const bareCount = rows.length - numbered.length
  const reviewedCount = rows.filter(
    (r) => r.vendorId || (r.expenseCategory ?? '').trim(),
  ).length

  let numberRange: CheckReviewSummary['numberRange'] = null
  if (numbered.length > 0) {
    const sorted = [...numbered].sort(
      (a, b) => Number(a.checkNumber) - Number(b.checkNumber),
    )
    numberRange = {
      min: sorted[0].checkNumber as string,
      max: sorted[sorted.length - 1].checkNumber as string,
    }
  }

  const byAmount = new Map<number, CheckRow[]>()
  for (const r of rows) {
    const key = cents(r.amount)
    if (key === 0) continue
    const list = byAmount.get(key) ?? []
    list.push(r)
    byAmount.set(key, list)
  }

  const amountClusters: CheckAmountCluster[] = []
  for (const [key, list] of byAmount) {
    if (list.length < minClusterSize) continue
    const dates = list.map((r) => r.transactionDate).filter(Boolean).sort()
    amountClusters.push({
      amount: key / 100,
      count: list.length,
      total: list.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0),
      checkNumbers: list
        .map((r) => r.checkNumber)
        .filter((n): n is string => Boolean(n)),
      transactionIds: list.map((r) => r.id),
      firstDate: dates[0] ?? '',
      lastDate: dates[dates.length - 1] ?? '',
      looksRecurring: list.length >= recurringThreshold,
    })
  }

  amountClusters.sort((a, b) => b.total - a.total)

  return {
    totalChecks: rows.length,
    totalAmount,
    numberedCount: numbered.length,
    bareCount,
    numberRange,
    amountClusters,
    reviewedCount,
  }
}

/* ------------------------------------------------------------------ */
/* Resolution overlay                                                  */
/* ------------------------------------------------------------------ */

/**
 * An owner-supplied answer for one check. Lives in `check_resolutions`, NEVER
 * written back onto `financial_transactions` — the bank export stays verbatim so
 * a resolution can always be undone and the original re-read.
 */
export type CheckResolution = {
  financialTransactionId: string
  checkNumber: string | null
  resolvedPayee: string | null
  resolvedVendorId: string | null
  resolvedCategory: string | null
  memo: string | null
  businessPurpose: string | null
  reviewStatus: 'pending' | 'approved' | 'rejected'
  confidence: CheckConfidence | null
  resolutionSource: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  bulkActionId: string | null
}

/**
 * How much the evidence supports a suggestion. Deliberately coarse — a numeric
 * score would imply precision the signals do not have.
 *
 * - `high`   — repeating amount AND a regular cadence (a standing payment).
 * - `medium` — repeating amount, or consecutive numbers on one day.
 * - `low`    — a weak hint; shown but never pre-selected.
 */
export type CheckConfidence = 'high' | 'medium' | 'low'

export type CheckSequence = {
  /** Consecutive check numbers with no gap. */
  checkNumbers: string[]
  transactionIds: string[]
  firstDate: string
  lastDate: string
  total: number
  /** Checks written in one sitting usually share a purpose (e.g. one delivery run). */
  sameDay: boolean
}

/**
 * Runs of consecutive check numbers.
 *
 * A gap is meaningful in the other direction too: it usually means a check was
 * voided or is missing from the export, which the owner should notice rather than
 * have smoothed over. So runs are split on any gap, never bridged.
 */
export function findCheckSequences(
  rows: CheckRow[],
  { minLength = 2 }: { minLength?: number } = {},
): CheckSequence[] {
  const numbered = rows
    .filter((r) => r.checkNumber && Number.isFinite(Number(r.checkNumber)))
    .sort((a, b) => Number(a.checkNumber) - Number(b.checkNumber))

  const runs: CheckRow[][] = []
  let current: CheckRow[] = []
  for (const r of numbered) {
    if (current.length === 0) {
      current = [r]
      continue
    }
    const prev = Number(current[current.length - 1].checkNumber)
    if (Number(r.checkNumber) === prev + 1) current.push(r)
    else {
      runs.push(current)
      current = [r]
    }
  }
  if (current.length > 0) runs.push(current)

  return runs
    .filter((run) => run.length >= minLength)
    .map((run) => {
      const dates = run.map((r) => r.transactionDate).filter(Boolean).sort()
      return {
        checkNumbers: run.map((r) => r.checkNumber as string),
        transactionIds: run.map((r) => r.id),
        firstDate: dates[0] ?? '',
        lastDate: dates[dates.length - 1] ?? '',
        total: run.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0),
        sameDay: dates.length > 0 && dates[0] === dates[dates.length - 1],
      }
    })
    .sort((a, b) => b.total - a.total)
}

export type CheckCadence = {
  /** Median gap in days between consecutive checks in the cluster. */
  medianGapDays: number
  /** 'weekly' | 'biweekly' | 'monthly' | 'irregular' */
  label: 'weekly' | 'biweekly' | 'monthly' | 'irregular'
  /** True when gaps are tight enough to look like a standing arrangement. */
  regular: boolean
  /** Gaps far outside the rhythm — usually a pause, not a change of payee. */
  breakCount: number
}

const CADENCE_BANDS: { label: Exclude<CheckCadence['label'], 'irregular'>; min: number; max: number }[] = [
  { label: 'weekly', min: 5, max: 9 },
  { label: 'biweekly', min: 12, max: 17 },
  { label: 'monthly', min: 26, max: 35 },
]

/**
 * Classify the rhythm of a set of dates.
 *
 * Uses the MEDIAN gap, not the mean: one long pause would drag a mean far enough
 * to mislabel an otherwise regular payment. Tolerances are wide because real
 * payments slip around weekends and holidays.
 *
 * Regularity is judged by what share of gaps sit INSIDE the matched band, not by
 * the overall spread. Real example from this data: $2,677.50 recurs at 28, 35,
 * 28, 33, 30 days with a single 115-day interruption. That is plainly a monthly
 * arrangement that paused, and a spread test would wrongly call it irregular and
 * bury a $18.7K group. Outliers are counted and reported as `breakCount` instead
 * of disqualifying the pattern.
 */
export function describeCadence(dates: string[]): CheckCadence | null {
  const sorted = [...new Set(dates.filter(Boolean))].sort()
  if (sorted.length < 3) return null // Two dates is one interval — not a rhythm.

  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const a = Date.parse(sorted[i - 1] + 'T00:00:00Z')
    const b = Date.parse(sorted[i] + 'T00:00:00Z')
    if (Number.isFinite(a) && Number.isFinite(b)) {
      gaps.push(Math.round((b - a) / 86400000))
    }
  }
  if (gaps.length === 0) return null

  const ascending = [...gaps].sort((x, y) => x - y)
  const mid = Math.floor(ascending.length / 2)
  const medianGapDays =
    ascending.length % 2 === 0
      ? (ascending[mid - 1] + ascending[mid]) / 2
      : ascending[mid]

  const band = CADENCE_BANDS.find(
    (b) => medianGapDays >= b.min && medianGapDays <= b.max,
  )
  const label: CheckCadence['label'] = band?.label ?? 'irregular'

  // Count gaps that fit the band. A majority is enough to call it a rhythm —
  // requiring every gap to conform would reject almost every real-world payment
  // schedule, which is exactly the failure mode being avoided here.
  const inBand = band ? gaps.filter((g) => g >= band.min && g <= band.max).length : 0
  const breakCount = band ? gaps.length - inBand : 0

  return {
    medianGapDays,
    label,
    regular: Boolean(band) && inBand / gaps.length >= 0.6,
    breakCount,
  }
}

export type CheckSuggestion = {
  /** Stable key so the UI can track selection across re-renders. */
  key: string
  kind: 'amount-cluster' | 'sequence'
  label: string
  /** Why this is being suggested, in the owner's terms. */
  rationale: string
  confidence: CheckConfidence
  transactionIds: string[]
  total: number
  count: number
  firstDate: string
  lastDate: string
  cadence: CheckCadence | null
}

/**
 * Build review suggestions from the structural signals available.
 *
 * These suggest WHICH checks belong together, never WHO was paid — the export
 * has no payee, so any guessed name would be fabrication. The owner supplies the
 * payee; the app only saves them from finding the group by hand.
 */
export function suggestCheckGroups(
  rows: CheckRow[],
  { recurringThreshold = 3 }: { recurringThreshold?: number } = {},
): CheckSuggestion[] {
  const out: CheckSuggestion[] = []
  const summary = summarizeChecks(rows, { minClusterSize: 2, recurringThreshold })
  const byId = new Map(rows.map((r) => [r.id, r]))

  for (const c of summary.amountClusters) {
    const dates = c.transactionIds
      .map((id) => byId.get(id)?.transactionDate ?? '')
      .filter(Boolean)
    const cadence = describeCadence(dates)

    // High only when BOTH the amount repeats and the timing is regular. An
    // identical amount alone could be a coincidence of round numbers.
    const confidence: CheckConfidence =
      c.looksRecurring && cadence?.regular
        ? 'high'
        : c.looksRecurring
          ? 'medium'
          : 'low'

    // A paused rhythm is still a rhythm, but say so rather than implying an
    // unbroken run — the gap may be a lapsed arrangement worth a second look.
    const breakNote =
      cadence?.regular && cadence.breakCount > 0
        ? `, with ${cadence.breakCount} longer ${cadence.breakCount === 1 ? 'pause' : 'pauses'}`
        : ''
    const cadenceNote = cadence?.regular
      ? ` on a ${cadence.label} rhythm (about every ${cadence.medianGapDays} days${breakNote})`
      : cadence
        ? ` at irregular intervals (median ${cadence.medianGapDays} days)`
        : ''

    out.push({
      key: `amount:${c.amount.toFixed(2)}`,
      kind: 'amount-cluster',
      label: `${c.count} checks of exactly $${c.amount.toFixed(2)}`,
      rationale: `The same amount was written ${c.count} times${cadenceNote}. Identical repeating amounts usually mean one payee on a standing arrangement, so naming them once is likely to settle all ${c.count}.`,
      confidence,
      transactionIds: [...c.transactionIds],
      total: c.total,
      count: c.count,
      firstDate: c.firstDate,
      lastDate: c.lastDate,
      cadence,
    })
  }

  for (const s of findCheckSequences(rows, { minLength: 3 })) {
    out.push({
      key: `seq:${s.checkNumbers[0]}-${s.checkNumbers[s.checkNumbers.length - 1]}`,
      kind: 'sequence',
      label: `Checks ${s.checkNumbers[0]}–${s.checkNumbers[s.checkNumbers.length - 1]} (${s.checkNumbers.length} in a row)`,
      rationale: s.sameDay
        ? `${s.checkNumbers.length} consecutive checks all written on ${s.firstDate}. Checks written in one sitting usually cover one errand or delivery run, so they often share a payee or purpose.`
        : `${s.checkNumbers.length} consecutive check numbers spanning ${s.firstDate} to ${s.lastDate}. Worth reviewing together — but the spread of dates means they may well be unrelated.`,
      // Same-day consecutive numbers are a real signal; spread out, they are
      // just adjacent numbering and prove nothing.
      confidence: s.sameDay ? 'medium' : 'low',
      transactionIds: [...s.transactionIds],
      total: s.total,
      count: s.checkNumbers.length,
      firstDate: s.firstDate,
      lastDate: s.lastDate,
      cadence: null,
    })
  }

  const rank: Record<CheckConfidence, number> = { high: 0, medium: 1, low: 2 }
  return out.sort(
    (a, b) => rank[a.confidence] - rank[b.confidence] || b.total - a.total,
  )
}

export type CheckResolutionProgress = {
  totalChecks: number
  totalAmount: number
  resolvedCount: number
  resolvedAmount: number
  pendingCount: number
  pendingAmount: number
  /** Share of check DOLLARS resolved — the figure that matters for COGS trust. */
  resolvedPctOfAmount: number
  /** Resolutions (from any source) that map a check into a COGS category. */
  cogsCount: number
  cogsAmount: number
  /** Resolved by an approved row in the `check_resolutions` overlay. */
  overlayCount: number
  overlayAmount: number
  /** Resolved because the transaction itself carries an `expense_category`. */
  categorizedCount: number
  categorizedAmount: number
  /** Resolved because the owner marked the transaction `excluded`. */
  excludedCount: number
  excludedAmount: number
  /**
   * Resolved by a `rejected` overlay — reviewed and recorded as not cost of
   * goods, with no payee named. Kept in its own bucket rather than folded into
   * `excluded`, which means "not business spend" and would be a different claim.
   */
  reviewedNotCogsCount: number
  reviewedNotCogsAmount: number
}

/** How a given check came to be answered — or that it has not been. */
export type CheckResolvedVia =
  | 'overlay'
  | 'categorized'
  | 'excluded'
  | 'reviewed-not-cogs'
  | 'unresolved'

/**
 * The single definition of "this check is answered", shared by the review queue,
 * the progress figures and the COGS roll-up.
 *
 * A check stops being an open question through any of three routes, and all
 * three must count or the same dollar is reported as both known and unknown:
 *
 *  1. `overlay`     — an approved `check_resolutions` row names the payee.
 *  2. `excluded`    — the owner marked the row excluded (an owner draw, a
 *                     transfer, capitalized equipment). This is the same
 *                     `reviewStatus !== 'excluded'` convention cash flow,
 *                     reporting and vendor spend already use.
 *  3. `categorized` — the transaction itself carries an `expense_category`,
 *                     e.g. applied from the accountant's General Ledger, which
 *                     identifies checks by check number.
 *
 *  4. `reviewed-not-cogs` — a `rejected` overlay: the owner looked and recorded
 *                     "not cost of goods" without naming a payee. This is a real
 *                     answer to the question gross profit asks, so it must count.
 *
 * Route 1 is checked first so an explicit resolution always wins over a category
 * that may have been applied in bulk.
 *
 * Route 4 exists because the review queue was already treating a rejected overlay
 * as settled while this function — and therefore the progress figures, the COGS
 * roll-up and the readiness gate — still called it unresolved. That split made a
 * check unreachable: hidden from every tab, yet counted in "still unknown"
 * forever, so the backlog could never reach zero. The caller must pass
 * `hasRejectedOverlay` for the two surfaces to agree.
 */
export function checkResolvedVia(
  row: Pick<CheckRow, 'expenseCategory' | 'reviewStatus'>,
  approvedOverlay: CheckResolution | undefined,
  hasRejectedOverlay = false,
): CheckResolvedVia {
  if (approvedOverlay) return 'overlay'
  if ((row.reviewStatus ?? '').trim() === 'excluded') return 'excluded'
  if ((row.expenseCategory ?? '').trim().length > 0) return 'categorized'
  // Checked after `categorized`: a real category is more informative than
  // "not COGS", and a row can carry both.
  if (hasRejectedOverlay) return 'reviewed-not-cogs'
  return 'unresolved'
}

/**
 * Progress through the check backlog.
 *
 * Reports dollars as well as counts, and leads with dollars: resolving 100 small
 * checks matters far less to gross profit than resolving five large ones.
 *
 * Each check lands in exactly one bucket, so `overlayAmount + categorizedAmount +
 * excludedAmount + reviewedNotCogsAmount + pendingAmount === totalAmount` always
 * holds and no dollar can be double-counted.
 */
export function checkResolutionProgress(
  rows: CheckRow[],
  resolutions: CheckResolution[],
  isCogsCategory: (category: string) => boolean,
): CheckResolutionProgress {
  const approved = new Map(
    resolutions
      .filter((r) => r.reviewStatus === 'approved')
      .map((r) => [r.financialTransactionId, r]),
  )

  let resolvedCount = 0
  let resolvedAmount = 0
  let cogsCount = 0
  let cogsAmount = 0
  let totalAmount = 0
  let overlayCount = 0
  let overlayAmount = 0
  let categorizedCount = 0
  let categorizedAmount = 0
  let excludedCount = 0
  let excludedAmount = 0
  let reviewedNotCogsCount = 0
  let reviewedNotCogsAmount = 0

  const rejectedIds = new Set(
    resolutions
      .filter((r) => r.reviewStatus === 'rejected')
      .map((r) => r.financialTransactionId),
  )

  for (const row of rows) {
    const amt = Math.abs(Number(row.amount) || 0)
    totalAmount += amt
    const res = approved.get(row.id)
    const via = checkResolvedVia(row, res, rejectedIds.has(row.id))
    if (via === 'unresolved') continue

    resolvedCount++
    resolvedAmount += amt

    // The category that answers this check depends on which route resolved it.
    // An excluded row is answered precisely BY not being spend, so it never
    // contributes to COGS regardless of any category left on it.
    let category = ''
    if (via === 'overlay') {
      overlayCount++
      overlayAmount += amt
      category = res?.resolvedCategory ?? ''
    } else if (via === 'categorized') {
      categorizedCount++
      categorizedAmount += amt
      category = row.expenseCategory ?? ''
    } else if (via === 'reviewed-not-cogs') {
      // Deliberately leaves `category` empty: "not COGS" is the whole content of
      // the answer, so this can never reach the COGS test below.
      reviewedNotCogsCount++
      reviewedNotCogsAmount += amt
    } else {
      excludedCount++
      excludedAmount += amt
    }

    if (category && isCogsCategory(category)) {
      cogsCount++
      cogsAmount += amt
    }
  }

  return {
    totalChecks: rows.length,
    totalAmount,
    resolvedCount,
    resolvedAmount,
    pendingCount: rows.length - resolvedCount,
    pendingAmount: totalAmount - resolvedAmount,
    resolvedPctOfAmount: totalAmount > 0 ? (resolvedAmount / totalAmount) * 100 : 0,
    cogsCount,
    cogsAmount,
    overlayCount,
    overlayAmount,
    categorizedCount,
    categorizedAmount,
    excludedCount,
    excludedAmount,
    reviewedNotCogsCount,
    reviewedNotCogsAmount,
  }
}
