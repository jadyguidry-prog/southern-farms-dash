// Groups spend rows that HAVE a real payee but NO spending category.
//
// This is deliberately the narrow middle case between two queues that already
// exist:
//
//   - Check Resolution owns rows with no payee at all. A bank sends no payee for
//     a check, so those can only be identified from the owner's own records.
//     They are excluded here — showing them twice would imply the same money can
//     be fixed in two places.
//   - Category Review's merge queue owns rows that DO have a category, where the
//     problem is four spellings of one category rather than a missing one.
//
// Everything here is DB-free so it can be tested against fixtures.

import { SPEND_TYPES } from '@/lib/transactions'
import { isGenericDescription, payeeKeyOf } from '@/lib/transaction-groups'

export type UncategorizedInputRow = {
  id: string
  transactionDate: string
  description: string
  amount: number
  transactionType: string
  reviewStatus: string
  expenseCategory: string
}

export type UncategorizedPayeeGroup = {
  /** Derived payee key — stable identifier for the group. */
  key: string
  /** Human-facing label: the most common full description in the group. */
  payee: string
  count: number
  /** Sum of magnitudes, so the owner can work highest-dollar first. */
  total: number
  firstDate: string
  lastDate: string
  /** Calendar months (yyyy-mm) the rows fall in, ascending. */
  months: string[]
  transactionIds: string[]
  /**
   * A category already recorded on OTHER rows of this same payee.
   *
   * This is evidence from the owner's own books, not a guess: if six
   * `TRACTOR SUPPLY` rows are already "Farm Supplies", the seventh almost
   * certainly is too. Null when no sibling row is categorized, in which case the
   * UI must not propose anything — an invented category would be placeholder
   * data wearing a suggestion's clothes.
   */
  siblingCategory: { category: string; count: number } | null
}

function monthKeyOf(date: string): string {
  return (date ?? '').slice(0, 7)
}

/** True for rows that represent money going out and are not excluded. */
function isCountableSpend(row: UncategorizedInputRow): boolean {
  if (row.reviewStatus === 'excluded') return false
  return SPEND_TYPES.includes(row.transactionType as never)
}

/**
 * Build the uncategorized-payee work queue, largest dollar amount first.
 *
 * Categorized rows are still read (to learn each payee's established category)
 * but are never returned as work.
 */
export function buildUncategorizedPayeeGroups(
  rows: UncategorizedInputRow[],
): UncategorizedPayeeGroup[] {
  // Pass 1: learn the category vocabulary each payee already uses.
  const siblingCategories = new Map<string, Map<string, number>>()
  for (const row of rows) {
    if (!isCountableSpend(row)) continue
    const category = (row.expenseCategory ?? '').trim()
    if (!category) continue
    if (isGenericDescription(row.description)) continue
    const key = payeeKeyOf(row.description)
    const counts = siblingCategories.get(key) ?? new Map<string, number>()
    counts.set(category, (counts.get(category) ?? 0) + 1)
    siblingCategories.set(key, counts)
  }

  // Pass 2: collect the rows that actually need a category.
  type Acc = {
    key: string
    labels: Map<string, number>
    ids: string[]
    total: number
    first: string
    last: string
    months: Set<string>
  }
  const groups = new Map<string, Acc>()

  for (const row of rows) {
    if (!isCountableSpend(row)) continue
    if ((row.expenseCategory ?? '').trim()) continue
    // Payee-less rows belong to Check Resolution, not here.
    if (isGenericDescription(row.description)) continue

    const key = payeeKeyOf(row.description)
    const acc =
      groups.get(key) ??
      ({
        key,
        labels: new Map<string, number>(),
        ids: [],
        total: 0,
        first: '',
        last: '',
        months: new Set<string>(),
      } satisfies Acc)

    const label = (row.description ?? '').trim()
    if (label) acc.labels.set(label, (acc.labels.get(label) ?? 0) + 1)
    acc.ids.push(row.id)
    acc.total += Math.abs(row.amount)
    const date = (row.transactionDate ?? '').slice(0, 10)
    if (date && (!acc.first || date < acc.first)) acc.first = date
    if (date > acc.last) acc.last = date
    const month = monthKeyOf(row.transactionDate)
    if (month) acc.months.add(month)
    groups.set(key, acc)
  }

  const out: UncategorizedPayeeGroup[] = []
  for (const acc of groups.values()) {
    // Label = the most common full description, matching how the vendor payee
    // groups elsewhere in the app name themselves.
    let payee = acc.key
    let best = 0
    for (const [label, n] of acc.labels) {
      if (n > best || (n === best && label.length < payee.length)) {
        payee = label
        best = n
      }
    }

    const counts = siblingCategories.get(acc.key)
    let siblingCategory: UncategorizedPayeeGroup['siblingCategory'] = null
    if (counts && counts.size > 0) {
      const [category, n] = [...counts].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]
      siblingCategory = { category, count: n }
    }

    out.push({
      key: acc.key,
      payee,
      count: acc.ids.length,
      total: acc.total,
      firstDate: acc.first,
      lastDate: acc.last,
      months: [...acc.months].sort(),
      transactionIds: acc.ids,
      siblingCategory,
    })
  }

  // Highest dollars first: that is the order that closes the reporting gap
  // fastest, which is the whole point of grouping by payee.
  return out.sort((a, b) => b.total - a.total || a.payee.localeCompare(b.payee))
}

/** Totals for the queue header, so the owner can see the gap shrink. */
export function summarizeUncategorizedPayees(groups: UncategorizedPayeeGroup[]): {
  payeeCount: number
  transactionCount: number
  total: number
} {
  return {
    payeeCount: groups.length,
    transactionCount: groups.reduce((s, g) => s + g.count, 0),
    total: groups.reduce((s, g) => s + g.total, 0),
  }
}
