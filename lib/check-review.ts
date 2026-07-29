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
