// Pure helpers for importing and interpreting bank/credit-card transactions.
// Deliberately DB-free so the logic can be reasoned about and unit tested.

export const TRANSACTION_TYPES = [
  'expense',
  'payment',
  'credit',
  'refund',
  'transfer',
  'fee',
  'interest',
  'income',
] as const
export type TransactionType = (typeof TRANSACTION_TYPES)[number]

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  expense: 'Expense',
  payment: 'Payment',
  credit: 'Credit',
  refund: 'Refund',
  transfer: 'Transfer',
  fee: 'Fee',
  interest: 'Interest',
  income: 'Income',
}

export const REVIEW_STATUSES = [
  'unreviewed',
  'matched',
  'needs_review',
  'excluded',
] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/**
 * Transaction types that represent money actually spent with a vendor.
 * `payment` and `transfer` are excluded on purpose: a credit-card payment or an
 * account-to-account transfer moves money but is not vendor spend, and counting
 * it would double-count the underlying purchases.
 */
export const SPEND_TYPES: TransactionType[] = ['expense', 'fee', 'interest']
/** Types that reduce spend when computing a net figure. */
export const SPEND_OFFSET_TYPES: TransactionType[] = ['refund', 'credit']

// ---------- Statement direction words ----------

/**
 * What a statement's type/indicator column is saying about DIRECTION.
 *
 * A bank writes "Credit" for money arriving and "Debit" for money leaving. Those
 * are directions, not this app's semantic types — and the vocabularies collide
 * dangerously on one word: here `credit` is a SPEND OFFSET (a refund that
 * reduces spending, see `SPEND_OFFSET_TYPES`). Trusting a bank's "Credit" label
 * as our `credit` type therefore turns every deposit into negative spending.
 *
 * That is exactly what happened to one imported month: 51 deposits (Square
 * payouts, DEPOSIT lines, WooPayments) were stored as `credit`, subtracted from
 * $1,527 of real costs, and the month reported cash out of -$96,116.
 *
 * So direction words are mapped to a sign and never used as a type.
 */
const STATEMENT_DIRECTION_WORDS: Record<string, 1 | -1> = {
  credit: 1,
  credits: 1,
  cr: 1,
  deposit: 1,
  deposits: 1,
  debit: -1,
  debits: -1,
  dr: -1,
  withdrawal: -1,
  withdrawals: -1,
}

/**
 * Read a statement's type column as a direction: `1` money in, `-1` money out,
 * `null` when the value says nothing about direction.
 *
 * This matters most for exports that list every amount as an unsigned magnitude
 * and carry the direction only in a separate column. Without it, such a file
 * looks like it is entirely income.
 */
export function parseStatementDirection(rawType: string): 1 | -1 | null {
  const key = rawType.trim().toLowerCase()
  return STATEMENT_DIRECTION_WORDS[key] ?? null
}

/**
 * A type from the statement that we trust verbatim, or `null` to infer instead.
 *
 * Deliberately rejects anything that is really a direction word (above), so an
 * ambiguous label is resolved from the description and sign by
 * `inferTransactionType` rather than taken at face value.
 */
export function trustedStatementType(rawType: string): TransactionType | null {
  const key = rawType.trim().toLowerCase()
  if (parseStatementDirection(key) !== null) return null
  return (TRANSACTION_TYPES as readonly string[]).includes(key)
    ? (key as TransactionType)
    : null
}

// ---------- Description normalization ----------

// Noise that banks prepend/append to the real merchant name.
const NOISE_PATTERNS: RegExp[] = [
  /\bPOS\s+(?:DEBIT|PURCHASE)\b/g,
  /\b(?:DEBIT|CREDIT)\s+CARD\s+(?:PURCHASE|PAYMENT)\b/g,
  /\bCHECK\s?CARD\b/g,
  /\bVISA\b|\bMASTERCARD\b|\bAMEX\b/g,
  /\bACH\s+(?:DEBIT|CREDIT|PAYMENT|WITHDRAWAL)\b/g,
  /\b(?:RECURRING\s+)?(?:PAYMENT|PMT)\s+AUTHORIZED\s+ON\b/g,
  /\bPURCHASE\s+AUTHORIZED\s+ON\b/g,
  /\bCARD\s+\d{4}\b/g,
  /\bXX+\d+\b/g,
  /\b(?:REF|TRACE|SEQ|ID|AUTH)\s*#?\s*[A-Z0-9]{4,}\b/g,
  /\bTERMINAL\s+\d+\b/g,
  /\bSTORE\s+#?\d+\b/g,
  /\b\d{2}\/\d{2}(?:\/\d{2,4})?\b/g, // embedded dates
  /\bWWW\.[A-Z0-9.-]+\b/g,
  /\b[A-Z0-9.-]+\.(?:COM|NET|ORG)\b/g,
]

/**
 * Collapse a raw statement line into a stable, comparable merchant string.
 * Used for vendor matching, duplicate detection, and recurring grouping, so it
 * must be deterministic: the same input always yields the same output.
 */
export function normalizeDescription(raw: string): string {
  if (!raw) return ''
  let out = raw.toUpperCase()

  for (const pattern of NOISE_PATTERNS) {
    out = out.replace(pattern, ' ')
  }

  // Drop trailing state/city noise separators and punctuation.
  out = out.replace(/[^A-Z0-9 &]/g, ' ')
  // Remove standalone long digit runs (reference numbers, phone numbers).
  out = out.replace(/\b\d{4,}\b/g, ' ')
  // Collapse whitespace.
  out = out.replace(/\s+/g, ' ').trim()

  return out
}

// ---------- Amount + type parsing ----------

/**
 * Parse a currency string into a number. Handles "$1,234.56", "(45.00)"
 * accounting negatives, and trailing-minus formats. Returns null when the
 * value cannot be read as a number, so callers can flag the row instead of
 * silently importing a zero.
 */
export function parseAmount(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') return null
  if (typeof input === 'number') return Number.isFinite(input) ? input : null

  let text = String(input).trim()
  let negative = false

  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1)
  }
  if (/-$/.test(text)) {
    negative = true
    text = text.replace(/-$/, '')
  }
  if (/^-/.test(text)) {
    negative = true
    text = text.replace(/^-/, '')
  }

  text = text.replace(/[$\s,]/g, '')
  if (text === '' || !/^\d*\.?\d+$/.test(text)) return null

  const value = Number.parseFloat(text)
  if (!Number.isFinite(value)) return null
  return negative ? -value : value
}

/** Card issuers / lenders whose name signals an account payoff, not a purchase. */
const ACCOUNT_ISSUER_PATTERN =
  /\b(?:AMEX|AMERICAN\s+EXPRESS|VISA|MASTERCARD|DISCOVER|CHASE|CAPITAL\s+ONE|CITI(?:BANK)?|SYNCHRONY|BARCLAY(?:S|CARD)?|WELLS\s+FARGO|BANK\s+OF\s+AMERICA)\b/

/**
 * Distinct electronic account-payoff phrasings, kept separate so they can be
 * COUNTED. One of these alone is ambiguous — "BILL PAY ENTERGY" is an ordinary
 * utility bill. Two together ("EPAYMENT ACH PMT") is settlement wording that a
 * vendor purchase does not use.
 */
const ACCOUNT_PAYOFF_PATTERNS: RegExp[] = [
  /\bE-?PAY(?:MENT)?\b/,
  /\bE-?PMT\b/,
  /\bACH\s+PMT\b/,
  /\bAUTO-?\s?PAY(?:MENT)?\b/,
  /\bONLINE\s+(?:PAYMENT|PMT)\b/,
  /\bBILL\s+PAY(?:MENT)?\b/,
  /\bCREDIT\s+CRD\b/,
]

/**
 * Does this line look like paying down a card or loan account?
 *
 * Checked against the RAW description on purpose. `normalizeDescription` strips
 * issuer names as merchant noise, so by the time a line reads "EPAYMENT ACH PMT"
 * the one word that identified it as a card payoff — "AMEX" — is already gone,
 * and it falls through to `expense`. That misread 9 AMEX payoffs as $36,354 of
 * vendor spend while the real purchases were also imported from the card
 * statement, double-counting the money.
 *
 * Accepts on any one of three signals, deliberately ordered strongest first:
 *   1. explicit "CARD/LOAN/MORTGAGE PAYMENT" wording;
 *   2. an issuer name plus payoff wording ("AMEX EPAYMENT");
 *   3. two distinct payoff phrasings together ("EPAYMENT ACH PMT") — needed
 *      because this bank drops the issuer entirely on some lines, so rule 2
 *      cannot see them.
 *
 * A single payoff phrase with no issuer stays spend, so paying a real vendor
 * online is never mistaken for a transfer between the owner's own accounts.
 */
export function looksLikeAccountPayoff(rawDescription: string): boolean {
  const raw = String(rawDescription ?? '').toUpperCase()
  if (!raw) return false
  if (/\b(?:CARD|CREDIT\s+CARD|LOAN|MORTGAGE)\s+(?:PAYMENT|PMT)\b/.test(raw)) return true

  const payoffHits = ACCOUNT_PAYOFF_PATTERNS.filter((p) => p.test(raw)).length
  if (payoffHits === 0) return false
  if (ACCOUNT_ISSUER_PATTERN.test(raw)) return true
  return payoffHits >= 2
}

/**
 * Infer a transaction type from the description and the direction of money.
 * `signedAmount` follows the CSV's own convention (negative = money out).
 * Keyword checks are intentionally conservative: anything unrecognized falls
 * back to expense/income by direction rather than guessing a specific type.
 *
 * `rawDescription` is optional and defaults to the normalized string. Pass the
 * pre-normalization line where available so issuer-based checks still work.
 */
export function inferTransactionType(
  normalizedDescription: string,
  signedAmount: number,
  rawDescription?: string,
): TransactionType {
  const d = normalizedDescription
  const raw = rawDescription ?? normalizedDescription
  const moneyOut = signedAmount < 0

  if (/\bINTEREST\b/.test(d)) return 'interest'
  if (/\b(?:OVERDRAFT|SERVICE\s+CHARGE|MONTHLY\s+FEE|LATE\s+FEE|NSF|FEE)\b/.test(d)) {
    return 'fee'
  }
  if (/\bTRANSFER\b|\bXFER\b/.test(d)) return 'transfer'
  if (/\bREFUND\b|\bRETURN\b|\bREVERSAL\b/.test(d)) return 'refund'
  // Checked before the generic direction fallback, and against the raw line so a
  // stripped issuer name cannot turn an account payoff into vendor spend.
  if (looksLikeAccountPayoff(raw)) return 'payment'
  if (/\bDEPOSIT\b/.test(d) && !moneyOut) return 'income'

  if (moneyOut) return 'expense'
  return 'income'
}

/**
 * How a statement represents the direction of money in its amount column.
 *
 * - `bank`: a checking/savings/line-of-credit export where money leaving the
 *   account is NEGATIVE (the default for most bank CSVs).
 * - `card`: a credit-card export where PURCHASES are POSITIVE and
 *   payments/credits are negative. Without correcting for this, every card
 *   purchase would look like income and vendor spend would read as zero.
 */
export const AMOUNT_CONVENTIONS = ['bank', 'card'] as const
export type AmountConvention = (typeof AMOUNT_CONVENTIONS)[number]

export const AMOUNT_CONVENTION_LABELS: Record<AmountConvention, string> = {
  bank: 'Bank account — money out is negative',
  card: 'Credit card — purchases are positive',
}

/**
 * Convert a CSV amount into the canonical convention used everywhere else in
 * this module: NEGATIVE means money out. For `bank` files the value already
 * follows that convention and is returned unchanged. For `card` files the sign
 * is flipped so a positive purchase becomes negative (money out) and a negative
 * card payment becomes positive (money in).
 */
export function canonicalizeSign(
  signedAmount: number,
  convention: AmountConvention,
): number {
  if (convention === 'card') return -signedAmount
  return signedAmount
}

/**
 * Sanity-check what an import is about to CLAIM before it is written.
 *
 * The two statement conventions are sign-inverted, so choosing the wrong one does not
 * fail — it succeeds and books every purchase as income. A card statement imported as
 * `bank` would silently inflate revenue by the full value of the file and understate
 * spending by the same amount, which is far worse than an error.
 *
 * This guard is deliberately about the OUTCOME, not the cause: it looks at the rows the
 * owner is about to commit and asks whether the mix is credible for the account type.
 * That catches a mis-set dropdown, a mis-mapped debit/credit pair, and a bank that
 * changed its export format, all with one check.
 *
 * Statements are overwhelmingly spending, so a file that is nearly all income is the
 * signature of an inverted sign. The threshold is high (not 50%) to stay quiet on a
 * genuine deposit-heavy checking export.
 */
export function summarizeImportDirection(
  rows: { transactionType: string; amount: number }[],
): {
  incomeCount: number
  expenseCount: number
  incomeTotal: number
  expenseTotal: number
  /** Share of rows booked as money IN, 0-1. Null when there are no rows to judge. */
  incomeShare: number | null
  /** True when the mix looks like an inverted sign rather than real income. */
  looksInverted: boolean
} {
  const isIncome = (t: string) => t === 'income'

  const income = rows.filter((r) => isIncome(r.transactionType))
  const expense = rows.filter((r) => !isIncome(r.transactionType))

  const sum = (rs: { amount: number }[]) =>
    rs.reduce((t, r) => t + Math.abs(r.amount), 0)

  const incomeShare = rows.length === 0 ? null : income.length / rows.length

  return {
    incomeCount: income.length,
    expenseCount: expense.length,
    incomeTotal: sum(income),
    expenseTotal: sum(expense),
    incomeShare,
    // Needs enough rows to be meaningful: a 2-row file that is 100% income is a
    // plausible pair of deposits, not evidence of an inverted statement.
    looksInverted: rows.length >= 5 && incomeShare !== null && incomeShare >= 0.9,
  }
}

// ---------- Vendor matching ----------

export type VendorMatchRule = {
  id: string
  vendor_id: string
  match_text: string
  match_type: 'exact' | 'contains' | 'starts_with'
  priority: number
  active: boolean
}

export type VendorMatch = {
  vendorId: string
  ruleId: string
  confidence: number
}

/**
 * Resolve a normalized description to a vendor using the stored rules.
 *
 * Rules are evaluated by ascending `priority` so specific rules (full vendor
 * name) win over broad fallbacks (first word). If two rules of the SAME
 * priority point at different vendors the match is ambiguous, and we return
 * null rather than picking arbitrarily — the row goes to manual review instead
 * of being silently attributed to the wrong vendor.
 */
export function matchVendor(
  normalizedDescription: string,
  rules: VendorMatchRule[],
): VendorMatch | null {
  if (!normalizedDescription) return null

  const active = rules
    .filter((r) => r.active && r.match_text)
    .sort((a, b) => a.priority - b.priority)

  const hits: VendorMatchRule[] = []
  for (const rule of active) {
    const text = rule.match_text.toUpperCase()
    let isHit = false

    if (rule.match_type === 'exact') {
      isHit = normalizedDescription === text
    } else if (rule.match_type === 'starts_with') {
      isHit = normalizedDescription.startsWith(text)
    } else {
      isHit = normalizedDescription.includes(text)
    }

    if (isHit) hits.push(rule)
  }

  if (hits.length === 0) return null

  const best = hits[0]
  const tied = hits.filter((h) => h.priority === best.priority)
  const distinctVendors = new Set(tied.map((h) => h.vendor_id))
  if (distinctVendors.size > 1) return null // ambiguous: send to review

  // Exact and specific matches earn higher confidence than broad fallbacks.
  const confidence =
    best.match_type === 'exact' ? 100 : best.priority <= 10 ? 90 : 65

  return { vendorId: best.vendor_id, ruleId: best.id, confidence }
}

// ---------- Duplicate detection ----------

export type DuplicateKeyInput = {
  transaction_date: string
  amount: number
  normalized_description: string | null
  account_name?: string | null
  external_transaction_id?: string | null
}

/**
 * Build the key used to detect re-imported rows. A bank-supplied id is
 * authoritative when present; otherwise we fall back to the natural key of
 * date + amount + merchant + account.
 *
 * Note this treats two genuinely separate same-day, same-amount purchases from
 * the same merchant as duplicates. That is the safer error for a farm ledger
 * (an inflated expense total is worse than a missing line the owner can
 * re-add), and the import preview lists every skipped row so it can be
 * overridden deliberately.
 */
export function duplicateKey(t: DuplicateKeyInput): string {
  if (t.external_transaction_id) {
    return `ext:${t.external_transaction_id}`
  }
  return [
    'nat',
    t.transaction_date,
    t.amount.toFixed(2),
    t.normalized_description ?? '',
    t.account_name ?? '',
  ].join('|')
}

// ---------- Recurring detection ----------

export type RecurringSample = {
  transaction_date: string
  amount: number
}

export type RecurringAnalysis = {
  isRecurring: boolean
  confidence: number
  cadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' | null
  averageAmount: number
  occurrences: number
  amountVariance: number
}

const CADENCE_WINDOWS: Array<{
  cadence: NonNullable<RecurringAnalysis['cadence']>
  min: number
  max: number
}> = [
  { cadence: 'weekly', min: 5, max: 9 },
  { cadence: 'biweekly', min: 12, max: 16 },
  { cadence: 'monthly', min: 26, max: 35 },
  { cadence: 'quarterly', min: 82, max: 100 },
  { cadence: 'annual', min: 350, max: 380 },
]

function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime()
  return Math.round(ms / 86_400_000)
}

/**
 * Decide whether a group of same-merchant transactions looks like a recurring
 * charge, based on the regularity of the gaps and the consistency of amounts.
 *
 * Requires at least 3 occurrences. Two charges a month apart is a coincidence,
 * not yet a pattern, and suggesting a recurring obligation from two data points
 * would put an unearned number in front of the owner.
 */
export function analyzeRecurring(samples: RecurringSample[]): RecurringAnalysis {
  const sorted = [...samples].sort((a, b) =>
    a.transaction_date < b.transaction_date ? -1 : 1,
  )
  const amounts = sorted.map((s) => Math.abs(s.amount))
  const averageAmount =
    amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0

  const empty: RecurringAnalysis = {
    isRecurring: false,
    confidence: 0,
    cadence: null,
    averageAmount,
    occurrences: sorted.length,
    amountVariance: 0,
  }

  if (sorted.length < 3) return empty

  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    gaps.push(daysBetween(sorted[i - 1].transaction_date, sorted[i].transaction_date))
  }

  const window = CADENCE_WINDOWS.find((w) =>
    gaps.every((g) => g >= w.min && g <= w.max),
  )
  if (!window) return empty

  // Relative spread of amounts. Utility bills drift; subscriptions don't.
  const maxAmount = Math.max(...amounts)
  const minAmount = Math.min(...amounts)
  const amountVariance =
    averageAmount > 0 ? (maxAmount - minAmount) / averageAmount : 0

  let confidence = 60
  if (sorted.length >= 4) confidence += 10
  if (sorted.length >= 6) confidence += 10
  if (amountVariance <= 0.05) confidence += 15
  else if (amountVariance <= 0.2) confidence += 5
  else if (amountVariance > 0.5) confidence -= 15

  confidence = Math.max(0, Math.min(100, confidence))

  return {
    isRecurring: confidence >= 60,
    confidence,
    cadence: window.cadence,
    averageAmount,
    occurrences: sorted.length,
    amountVariance,
  }
}

/** Map a detected cadence onto the frequency vocabulary cash_obligations uses. */
export function cadenceToFrequency(
  cadence: RecurringAnalysis['cadence'],
): string | null {
  switch (cadence) {
    case 'weekly':
      return 'Weekly'
    case 'biweekly':
      return 'Bi-Weekly'
    case 'monthly':
      return 'Monthly'
    case 'quarterly':
      return 'Quarterly'
    case 'annual':
      return 'Annually'
    default:
      return null
  }
}

// ---------- CSV field mapping ----------

export type ColumnRole =
  | 'ignore'
  | 'transaction_date'
  | 'posted_date'
  | 'description'
  | 'amount'
  | 'debit'
  | 'credit'
  | 'transaction_type'
  | 'account_name'
  | 'external_transaction_id'
  | 'expense_category'

/** Header keywords used to pre-select a role for each CSV column. */
const HEADER_HINTS: Array<{ role: ColumnRole; patterns: RegExp[] }> = [
  { role: 'posted_date', patterns: [/post(ed)?\s*date/i, /settle/i] },
  { role: 'transaction_date', patterns: [/trans(action)?\s*date/i, /^date$/i, /date/i] },
  { role: 'description', patterns: [/description/i, /payee/i, /merchant/i, /memo/i, /name/i, /details/i] },
  { role: 'debit', patterns: [/debit/i, /withdrawal/i, /paid\s*out/i] },
  { role: 'credit', patterns: [/credit/i, /deposit/i, /paid\s*in/i] },
  { role: 'amount', patterns: [/amount/i, /value/i] },
  { role: 'transaction_type', patterns: [/^type$/i, /trans(action)?\s*type/i] },
  { role: 'account_name', patterns: [/account/i, /card/i] },
  { role: 'external_transaction_id', patterns: [/transaction\s*id/i, /reference/i, /^ref/i, /check\s*number/i] },
  { role: 'expense_category', patterns: [/category/i, /class/i] },
]

/**
 * Best-effort guess of what each CSV column means, so the owner starts from a
 * sensible mapping instead of a blank form. Every guess stays editable — the
 * import only trusts what is confirmed on screen.
 */
export function guessColumnRoles(headers: string[]): Record<string, ColumnRole> {
  const result: Record<string, ColumnRole> = {}
  const taken = new Set<ColumnRole>()

  for (const header of headers) {
    let role: ColumnRole = 'ignore'
    for (const hint of HEADER_HINTS) {
      if (taken.has(hint.role)) continue
      if (hint.patterns.some((p) => p.test(header))) {
        role = hint.role
        break
      }
    }
    if (role !== 'ignore') taken.add(role)
    result[header] = role
  }

  return result
}

/**
 * Parse a date cell into an ISO `yyyy-mm-dd` string.
 * Ambiguous formats are resolved US-style (mm/dd/yyyy) to match US bank
 * exports; a day value above 12 is used to detect and correct dd/mm input.
 */
export function parseDate(input: string | null | undefined): string | null {
  if (!input) return null
  const text = String(input).trim()
  if (!text) return null

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (slash) {
    let [, first, second, year] = slash
    let month = Number.parseInt(first, 10)
    let day = Number.parseInt(second, 10)
    // Unambiguous dd/mm input: swap.
    if (month > 12 && day <= 12) {
      const tmp = month
      month = day
      day = tmp
    }
    let y = Number.parseInt(year, 10)
    if (year.length === 2) y += y < 70 ? 2000 : 1900
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

/** First day of the month a date falls in, used for statement grouping. */
export function statementMonthOf(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`
}
