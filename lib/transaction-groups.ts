// Pure helpers for collapsing many transactions into reviewable payee groups.
// Deliberately DB-free so the logic can be unit tested without a database.

import {
  SPEND_TYPES,
  SPEND_OFFSET_TYPES,
  type ReviewStatus,
  type TransactionType,
} from '@/lib/transactions'

/**
 * Leading tokens banks prepend before the real merchant name. Stripped when
 * deriving a group key so "IN VOIRON S SPECIALTY MEATS" and
 * "VOIRON S SPECIALTY MEAT BELLE CHASSE" collapse into one group instead of
 * forcing the owner to assign the same vendor twice.
 */
const LEAD_NOISE = new Set([
  'IN',
  'POS',
  'PAYPAL',
  'INST',
  'XFER',
  'ACH',
  'WEB',
  'PPD',
  'CCD',
  'TEL',
  'ARC',
  'DEBIT',
  'CREDIT',
  'PURCHASE',
  'PAYMENT',
  'RECURRING',
  'SQ',
  'SQUARE',
  'TST',
  'INTUIT',
])

/**
 * Statement lines that never name a payee. These are grouped separately because
 * no amount of matching can identify them — the bank simply didn't record who
 * was paid, and most aren't vendor spend at all.
 */
const GENERIC_PREFIXES = [
  'CHECK',
  'DEPOSIT',
  'INTERNET TRANSFER',
  'ONLINE TRANSFER',
  'TRANSFER',
  'LOAN PAYMENT',
  'LOAN',
  'ACH PAYMENT',
  'OWNER DRAW',
  'WITHDRAWAL',
  'SERVICE CHARGE',
  'OVERDRAFT',
  'WIRE TRANSFER',
  'CASH WITHDRAWAL',
  'ATM WITHDRAWAL',
  'COUNTER WITHDRAWAL',
  'BANKCARD DEP',
  'MERCH DEP',
  'INTEREST',
  'RETURNED ITEM',
  'NSF',
]

/** True when the line has no identifiable payee in it. */
export function isGenericDescription(normalized: string): boolean {
  const text = (normalized ?? '').trim().toUpperCase()
  if (!text) return true
  // A bare number or a very short fragment tells us nothing.
  if (text.replace(/[^A-Z]/g, '').length < 3) return true
  return GENERIC_PREFIXES.some(
    (p) => text === p || text.startsWith(`${p} `) || text.includes(` ${p} `),
  )
}

/**
 * True for per-transaction reference codes such as Square's `T3HE2CY0135A7GJ`.
 *
 * These must not reach the group key: they are unique per payment, so keeping
 * them puts every single run in its own group of one. That silently defeats
 * category learning — 54 `Square Inc PAYROLL <ref>` rows produced 54 distinct
 * "payees", so the category the owner had already assigned 39 times could never
 * propagate to a new payroll row.
 *
 * Kept deliberately narrow: a token must mix letters with at least two digits
 * AND be at least six characters long. Real merchant names that contain a digit
 * ("7 ELEVEN", "76", "STORE 5") stay intact because they are short, hold a
 * single digit, or split into separate tokens.
 */
function isReferenceToken(token: string): boolean {
  if (token.length < 6) return false
  const digits = (token.match(/\d/g) ?? []).length
  return digits >= 2 && /[A-Z]/.test(token) && /^[A-Z0-9]+$/.test(token)
}

/**
 * Company-form words that don't identify anything on their own. A key made only
 * of these is worse than a noisy one: `Square Inc SQ250505 <ref>` reduces to
 * "INC", which would sweep sales deposits and card fees into a single group.
 */
const CORPORATE_SUFFIXES = new Set([
  'INC',
  'INCORPORATED',
  'LLC',
  'LLP',
  'CO',
  'CORP',
  'CORPORATION',
  'LTD',
  'LP',
  'PLLC',
])

/** A token that actually says who was paid. */
function isMeaningfulToken(token: string): boolean {
  return token.length >= 3 && !CORPORATE_SUFFIXES.has(token)
}

/**
 * Derive the grouping key for a statement line.
 *
 * For generic lines the key is the matching generic prefix, so every `CHECK
 * 1041`, `CHECK 1042`... lands in a single "Check" group. For real payees we
 * drop leading bank noise plus per-transaction reference codes and keep the
 * first few significant tokens, which merges the same merchant written slightly
 * differently across statements.
 */
export function payeeKeyOf(normalized: string): string {
  const text = (normalized ?? '').trim().toUpperCase()
  if (!text) return 'UNKNOWN'

  if (isGenericDescription(text)) {
    const hit = GENERIC_PREFIXES.find(
      (p) => text === p || text.startsWith(`${p} `) || text.includes(` ${p} `),
    )
    return hit ?? 'UNIDENTIFIED'
  }

  const tokens = text.split(/\s+/).filter(Boolean)
  let start = 0
  while (start < tokens.length - 1 && LEAD_NOISE.has(tokens[start])) start += 1

  const rest = tokens.slice(start)
  const withoutRefs = rest.filter(
    (t) => !/^\d+$/.test(t) && !isReferenceToken(t),
  )

  // Dropping the reference code is only safe while something identifying
  // survives. When it doesn't, the code was the sole distinguishing content, so
  // we keep the raw tokens rather than collapse unrelated activity together.
  const significant = withoutRefs.some(isMeaningfulToken)
    ? withoutRefs
    : rest.filter((t) => !/^\d+$/.test(t))

  const key = (significant.length > 0 ? significant : rest).slice(0, 3).join(' ')

  return key || text
}

export type GroupInputRow = {
  id: string
  transactionDate: string
  description: string
  normalizedDescription: string
  amount: number
  transactionType: TransactionType
  reviewStatus: ReviewStatus
  vendorId: string | null
  expenseCategory: string
}

export type PayeeGroup = {
  /** Stable identifier for the group (the derived payee key). */
  key: string
  /** Human-facing label: the most common full description in the group. */
  payee: string
  /** Generic groups have no identifiable payee and are reviewed separately. */
  generic: boolean
  transactionIds: string[]
  count: number
  /** Net vendor spend: expense/fee/interest less refunds/credits. */
  totalSpend: number
  /** Sum of every magnitude in the group, regardless of type. */
  totalAmount: number
  firstDate: string
  lastDate: string
  /** A few raw statement lines so the owner can confirm what this is. */
  exampleDescriptions: string[]
  /** Vendor already attached to some rows in this group, if any. */
  suggestedVendorId: string | null
  /** Category already present on some rows, if any. */
  suggestedCategory: string
  /** Distinct review statuses present, so mixed groups are visible. */
  statuses: ReviewStatus[]
  /** Distinct transaction types present. */
  types: TransactionType[]
  accounts: string[]
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) {
    if (!v) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best = ''
  let bestN = -1
  for (const [v, n] of counts) {
    // Tie-break on the shorter string, which is usually the cleaner label.
    if (n > bestN || (n === bestN && v.length < best.length)) {
      best = v
      bestN = n
    }
  }
  return best
}

/**
 * Collapse rows into groups keyed by payee, ordered by the dollars at stake.
 *
 * Sorting by spend is the whole point: with hundreds of distinct payees, the
 * owner needs the handful that carry most of the money at the top rather than a
 * flat list ordered by date.
 */
export function buildPayeeGroups(rows: GroupInputRow[]): PayeeGroup[] {
  const buckets = new Map<string, GroupInputRow[]>()

  for (const row of rows) {
    const key = payeeKeyOf(row.normalizedDescription)
    const list = buckets.get(key)
    if (list) list.push(row)
    else buckets.set(key, [row])
  }

  const groups: PayeeGroup[] = []

  for (const [key, list] of buckets) {
    let totalSpend = 0
    let totalAmount = 0
    let firstDate = ''
    let lastDate = ''
    const statuses = new Set<ReviewStatus>()
    const types = new Set<TransactionType>()
    const accounts = new Set<string>()
    let suggestedVendorId: string | null = null
    let suggestedCategory = ''

    for (const row of list) {
      const magnitude = Math.abs(Number(row.amount) || 0)
      totalAmount += magnitude
      if (SPEND_TYPES.includes(row.transactionType)) totalSpend += magnitude
      else if (SPEND_OFFSET_TYPES.includes(row.transactionType)) {
        totalSpend -= magnitude
      }

      const date = row.transactionDate
      if (date) {
        if (!firstDate || date < firstDate) firstDate = date
        if (!lastDate || date > lastDate) lastDate = date
      }

      statuses.add(row.reviewStatus)
      types.add(row.transactionType)
      if (row.vendorId && !suggestedVendorId) suggestedVendorId = row.vendorId
      if (row.expenseCategory && !suggestedCategory) {
        suggestedCategory = row.expenseCategory
      }
    }

    groups.push({
      key,
      payee: mostCommon(list.map((r) => r.normalizedDescription)) || key,
      generic: isGenericDescription(list[0].normalizedDescription),
      transactionIds: list.map((r) => r.id),
      count: list.length,
      totalSpend,
      totalAmount,
      firstDate,
      lastDate,
      exampleDescriptions: [
        ...new Set(list.map((r) => r.description).filter(Boolean)),
      ].slice(0, 3),
      suggestedVendorId,
      suggestedCategory,
      statuses: [...statuses],
      types: [...types],
      accounts: [...accounts],
    })
  }

  return groups.sort((a, b) => {
    // Dollars first, then volume, so the highest-impact work surfaces up top.
    if (b.totalSpend !== a.totalSpend) return b.totalSpend - a.totalSpend
    if (b.totalAmount !== a.totalAmount) return b.totalAmount - a.totalAmount
    return b.count - a.count
  })
}

/**
 * Bulk classifications available for lines with no identifiable payee.
 *
 * Each maps to a real `transaction_type` so downstream spend math stays honest:
 * transfers and loan/card payments must not count as vendor spend or the
 * underlying purchases get double-counted.
 */
export const GENERIC_CLASSIFICATIONS = [
  'transfer',
  'loan_payment',
  'card_payment',
  'payroll',
  'tax_payment',
  'income',
  'needs_review',
  'excluded',
] as const
export type GenericClassification = (typeof GENERIC_CLASSIFICATIONS)[number]

export const GENERIC_CLASSIFICATION_LABELS: Record<
  GenericClassification,
  string
> = {
  transfer: 'Transfer between accounts',
  loan_payment: 'Loan payment',
  card_payment: 'Credit-card payment',
  payroll: 'Payroll',
  tax_payment: 'Tax payment',
  income: 'Income / deposit',
  needs_review: 'Check requiring review',
  excluded: 'Exclude from vendor spend',
}

export type ClassificationEffect = {
  transactionType: TransactionType | null
  reviewStatus: ReviewStatus
  category: string | null
}

/**
 * Translate a classification into the concrete column values to write.
 * Returning a plain object keeps the decision testable and keeps the server
 * action free of business rules.
 */
export function classificationEffect(
  classification: GenericClassification,
): ClassificationEffect {
  switch (classification) {
    case 'transfer':
      return { transactionType: 'transfer', reviewStatus: 'matched', category: null }
    case 'loan_payment':
      return {
        transactionType: 'payment',
        reviewStatus: 'matched',
        category: 'Debt Service',
      }
    case 'card_payment':
      return {
        transactionType: 'payment',
        reviewStatus: 'matched',
        category: 'Card Payment',
      }
    case 'payroll':
      return {
        transactionType: 'expense',
        reviewStatus: 'matched',
        category: 'Payroll',
      }
    case 'tax_payment':
      return {
        transactionType: 'expense',
        reviewStatus: 'matched',
        category: 'Taxes',
      }
    case 'income':
      return { transactionType: 'income', reviewStatus: 'matched', category: null }
    case 'needs_review':
      return { transactionType: null, reviewStatus: 'needs_review', category: null }
    case 'excluded':
      return { transactionType: null, reviewStatus: 'excluded', category: null }
  }
}

/**
 * Build a conservative match rule phrase from a group.
 *
 * Deliberately narrow: we use the derived payee key, which is the part of the
 * description that was stable across every row in the group. A broader phrase
 * risks silently attributing an unrelated merchant to this vendor on a future
 * import.
 */
export function ruleTextForGroup(group: PayeeGroup): string | null {
  const text = group.key.trim().toUpperCase()
  if (group.generic) return null // never auto-match a CHECK or DEPOSIT line
  if (text.replace(/[^A-Z]/g, '').length < 4) return null
  return text
}
