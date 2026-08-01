// Sales tax currently classified as an operating expense.
//
// Sales tax is money collected from customers on the store's behalf and remitted
// to the state. It was never the store's revenue and it is not the store's
// expense — it is a pass-through liability. Leaving it inside operating expenses
// overstates what it costs to run the business and understates true margin.
//
// This module only DESCRIBES the situation and the two available treatments. It
// changes nothing: the owner decides, and the decision is applied through the
// existing audited bulk-action framework so it can be undone.
//
// DB-free so the arithmetic and the impact statements are unit tested.

/** Detects a stored category that represents remitted sales tax. */
export function isSalesTaxCategory(category: string): boolean {
  const raw = String(category ?? '').trim()
  if (!raw) return false
  return /sales\s*(&|and)?\s*use\s*tax|\bsales\s*tax\b/i.test(raw)
}

export type SalesTaxRow = {
  id: string
  transactionDate: string
  amount: number
  description: string
  /** The category the row carries today, e.g. `State Sales Tax`. */
  expenseCategory: string
  reviewStatus: string
  transactionType: string
}

export type SalesTaxTreatment = {
  /** `reclassify` keeps the cash movement, `exclude` removes it entirely. */
  kind: 'reclassify' | 'exclude'
  label: string
  /** The category applied when this treatment is chosen (reclassify only). */
  category: string | null
  /** Why this is or is not the safe choice, in the owner's terms. */
  rationale: string
  /** True for the treatment that keeps every other report reconciling. */
  recommended: boolean
}

/**
 * The category used when sales tax is reclassified.
 *
 * Named as a pass-through rather than an expense so it reads correctly wherever
 * categories are listed, and kept distinct from the original `State Sales Tax`
 * so the change is visible rather than silent.
 */
export const SALES_TAX_PASS_THROUGH_CATEGORY = 'Sales Tax Remitted (Pass-Through)'

export type SalesTaxReviewGroup = {
  rows: SalesTaxRow[]
  count: number
  totalAmount: number
  /** Earliest and latest remittance date in the group. */
  firstDate: string
  lastDate: string
  /** Distinct categories these rows carry today. */
  currentCategories: string[]
  /** Distinct payees/descriptions, so the owner recognises the recipient. */
  payees: string[]
  treatments: SalesTaxTreatment[]
  /** Effect on reported operating expenses. */
  expenseImpact: string
  /** Effect on cash out — the reconciliation risk. */
  cashFlowImpact: string
  /** Effect on whether gross profit can be reported. */
  grossProfitImpact: string
}

function fmt(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Group the sales-tax rows still sitting in expenses.
 *
 * Returns null when there is nothing to review, so the UI shows no empty card.
 * Excluded rows are skipped: they are already out of every expense figure, so
 * presenting them as an open question would be false.
 */
export function deriveSalesTaxReview(
  rows: SalesTaxRow[],
): SalesTaxReviewGroup | null {
  const open = rows.filter(
    (r) =>
      isSalesTaxCategory(r.expenseCategory) &&
      (r.reviewStatus ?? '').trim() !== 'excluded',
  )
  if (open.length === 0) return null

  const sorted = [...open].sort((a, b) =>
    a.transactionDate.localeCompare(b.transactionDate),
  )
  const totalAmount = sorted.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0)
  const dates = sorted.map((r) => r.transactionDate).filter(Boolean)

  return {
    rows: sorted,
    count: sorted.length,
    totalAmount,
    firstDate: dates[0] ?? '',
    lastDate: dates[dates.length - 1] ?? '',
    currentCategories: [
      ...new Set(sorted.map((r) => r.expenseCategory.trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b)),
    payees: [
      ...new Set(sorted.map((r) => r.description.trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b)),
    treatments: [
      {
        kind: 'reclassify',
        label: `Reclassify to “${SALES_TAX_PASS_THROUGH_CATEGORY}”`,
        category: SALES_TAX_PASS_THROUGH_CATEGORY,
        rationale:
          'Keeps the payment in cash out — the money really did leave the bank — while taking it out of operating expenses, where it was never yours to spend. Every other report continues to reconcile to the bank export.',
        recommended: true,
      },
      {
        kind: 'exclude',
        label: 'Exclude from spend entirely',
        category: null,
        rationale: `Removes these rows from every figure, including cash out. Cash paid out would fall by ${fmt(totalAmount)} and would no longer match the bank statement, so this is only right if these payments were recorded twice.`,
        recommended: false,
      },
    ],
    expenseImpact: `Reclassifying moves ${fmt(totalAmount)} out of operating expenses across ${sorted.length} ${sorted.length === 1 ? 'payment' : 'payments'}. Reported expenses fall by that amount, so what it actually costs to run the store becomes accurate.`,
    cashFlowImpact: `No change if reclassified: the ${fmt(totalAmount)} still left the bank and still counts as cash out, so cash flow keeps reconciling to the raw transactions. Choosing exclude instead would reduce cash out by ${fmt(totalAmount)} and break that reconciliation.`,
    grossProfitImpact:
      'No effect either way. Sales tax is not cost of goods, so it never entered the COGS figure and the gross profit readiness gate does not move.',
  }
}
