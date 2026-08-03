/**
 * Spending capacity: "what can I safely spend today, and over the next 7 days?"
 *
 * Every function here is pure so the arithmetic can be unit-tested without a
 * database. The rules below are not arbitrary — each one was derived from the
 * live ledger, and getting any of them wrong produces a confidently wrong dollar
 * figure, which is worse than showing nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLASSIFICATION RULES EXIST (evidence from the real books)
 * ---------------------------------------------------------------------------
 * 1. CARD ROWS ARE NOT CASH. The ledger holds both checking rows and American
 *    Express rows. A card purchase does not move cash — the cash leaves later,
 *    when the card is paid off from checking. Counting the purchase AND the
 *    payoff double-counts the same dollars. So only operating-account rows are
 *    counted, and the card payoff (which appears on checking) is the cash event.
 *
 * 2. FINANCING IS NOT SALES. A $36,416 Square Capital advance landed on
 *    2026-06-08 with the description "Square Inc SQ CAP5725". It is an inflow,
 *    it says "Square", and a naive filter treats it as a monster sales day —
 *    inflating the weekly average by ~$4,500/wk of money that will never
 *    recur. Real settlements look like "SQ260729" (SQ + date); advances look
 *    like "SQ CAP". Financing is excluded from expected income.
 *
 * 3. INTERNAL TRANSFERS ARE NOT SPENDING, BUT THEY DO MOVE THE BALANCE. Moving
 *    money to Square Savings is not an expense, so transfers are excluded from
 *    spending estimates. They are stored with POSITIVE amounts in BOTH directions
 *    ("Internet Transfer to Acct# 2008275" vs "...From Acct 2008275"), so
 *    direction must be read from the wording, never from the sign.
 *    They are NOT net-zero: reconciliation against the real balance showed
 *    transfers are strongly asymmetric (~$21k in vs ~$43k out) because the
 *    counterpart accounts are absent from this ledger. Treating them as zero
 *    deleted ~$45k of real movement and drove the reconstructed balance to
 *    -$7,366 on a day the account was never overdrawn. Hence `internal_in` and
 *    `internal_out`: ignored for spending, honoured for balance.
 *
 * 4. MEDIANS, NOT AVERAGES. On 2026-06-08 a $36,416 advance arrived and a
 *    $32,128 check went out the same day — a one-off financing event. A mean
 *    would smear that across every week and distort the forecast for months. A
 *    median ignores it, which is exactly the desired behaviour.
 *
 * All amounts in this ledger are stored POSITIVE; direction comes from the
 * transaction type. Nothing here assumes a sign.
 */

/** A row from `financial_transactions`, narrowed to what the math needs. */
export type LedgerRow = {
  date: string // YYYY-MM-DD
  amount: number // always positive; direction comes from `type`
  type: string // income | credit | refund | expense | fee | payment | transfer
  description: string
  accountName: string
}

/** A dated item we know about specifically, rather than estimating. */
export type DatedOutflow = {
  date: string // YYYY-MM-DD
  amount: number
  label: string
}

export type FlowClass =
  | 'in' // real operating money arriving
  | 'out' // real cash leaving an operating account
  | 'internal_in' // arrived from another account we own (not revenue)
  | 'internal_out' // sent to another account we own (not spending)
  | 'financing' // loan/advance proceeds — real cash, but never recurring
  | 'ignored' // not an operating cash account (e.g. a credit card)

/** Transaction types that increase an operating balance. */
const INFLOW_TYPES = new Set(['income', 'credit', 'refund'])

/**
 * Square Capital advances/repayments. Matched before the generic Square
 * settlement case because "SQ CAP" also contains "SQ".
 */
const FINANCING_PATTERN = /SQ\s*CAP|SQUARE\s+CAPITAL|LOAN\s+(ADVANCE|PROCEED)|ADVANCE\s+DEPOSIT/
/**
 * Movements between accounts the business already owns.
 *
 * These are excluded from SPENDING estimates (moving your own money is not an
 * expense), but they are NOT net-zero for this account's balance: the counterpart
 * accounts (a second bank account, Square Financial) are absent from this ledger,
 * and observed transfers are strongly asymmetric — ~$21k in vs ~$43k out. Treating
 * them as zero deleted real cash movement and drove the reconstructed balance
 * thousands of pounds negative. So direction IS read here, from the description.
 */
const INTERNAL_PATTERN = /INTERNET\s+TRANSFER|SQUARE\s+FIN\s+SVCS\s+TRANSFER|TRANSFER\s+(TO|FROM)\s+ACCT/
/** "From Acct 2008275" / "From Savings" => money arriving in this account. */
const INTERNAL_INBOUND_PATTERN = /\bFROM\b/

/** Round to cents, so repeated float math can't drift into fractions. */
function money(n: number) {
  return Math.round(n * 100) / 100
}

/**
 * Decide what a single ledger row means for cash.
 *
 * `operatingAccounts` must list the account names that hold spendable cash.
 * Anything else (credit cards) is ignored rather than guessed at.
 */
export function classifyFlow(
  row: Pick<LedgerRow, 'type' | 'description' | 'accountName'>,
  operatingAccounts: string[],
): FlowClass {
  const isOperating = operatingAccounts.some(
    (name) => name && row.accountName === name,
  )
  if (!isOperating) return 'ignored'

  const d = (row.description ?? '').toUpperCase()
  const type = (row.type ?? '').toLowerCase()

  // Financing first: an advance is an inflow that must never look like sales.
  if (FINANCING_PATTERN.test(d)) return 'financing'
  // Internal moves next, since they can carry any transaction type. Direction comes
  // from the wording because every amount in this ledger is stored positive.
  if (type === 'transfer' || INTERNAL_PATTERN.test(d)) {
    return INTERNAL_INBOUND_PATTERN.test(d) ? 'internal_in' : 'internal_out'
  }

  return INFLOW_TYPES.has(type) ? 'in' : 'out'
}

/** ISO weekday, 1 = Monday .. 7 = Sunday, computed in local time. */
export function isoDayOfWeek(dateStr: string) {
  const d = parseDate(dateStr)
  const js = d.getDay() // 0 = Sunday
  return js === 0 ? 7 : js
}

/** Parse YYYY-MM-DD as a LOCAL date, avoiding UTC off-by-one shifts. */
export function parseDate(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/** Format a Date back to YYYY-MM-DD in local time. */
export function formatDate(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function addDays(dateStr: string, days: number) {
  const d = parseDate(dateStr)
  d.setDate(d.getDate() + days)
  return formatDate(d)
}

/** Monday of the week containing `dateStr`, used to bucket weekly totals. */
export function weekStart(dateStr: string) {
  return addDays(dateStr, -(isoDayOfWeek(dateStr) - 1))
}

/**
 * Linear-interpolated quantile over an unsorted list.
 * Returns 0 for an empty list so callers never produce NaN on screen.
 */
export function quantile(values: number[], q: number) {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  if (s.length === 1) return s[0]
  const pos = (s.length - 1) * Math.min(Math.max(q, 0), 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return s[lo]
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

export type WeeklyFlow = { weekStart: string; inflow: number; outflow: number }

/**
 * Group classified rows into complete weekly buckets.
 *
 * Partial weeks are dropped: a week containing only Monday and Tuesday would
 * look like a catastrophic revenue collapse and drag the median down. `today`
 * marks the current (incomplete) week, which is therefore excluded.
 */
export function buildWeeklyFlows(
  rows: LedgerRow[],
  options: { operatingAccounts: string[]; today: string; excludeMatchers?: string[] },
): WeeklyFlow[] {
  const { operatingAccounts, today, excludeMatchers = [] } = options
  const currentWeek = weekStart(today)
  const byWeek = new Map<string, WeeklyFlow>()

  for (const row of rows) {
    if (!row.date) continue
    const wk = weekStart(row.date)
    // Drop the in-progress week so a half-finished week can't skew the median.
    if (wk >= currentWeek) continue

    const cls = classifyFlow(row, operatingAccounts)
    if (cls !== 'in' && cls !== 'out') continue

    // Rows we model explicitly by date (scheduled obligations, logged drafts)
    // are removed from the estimated baseline. Leaving them in would charge the
    // same bill twice: once as an estimate, once on its real due date.
    if (cls === 'out' && matchesAny(row.description, excludeMatchers)) continue

    const bucket = byWeek.get(wk) ?? { weekStart: wk, inflow: 0, outflow: 0 }
    if (cls === 'in') bucket.inflow = money(bucket.inflow + row.amount)
    else bucket.outflow = money(bucket.outflow + row.amount)
    byWeek.set(wk, bucket)
  }

  return [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart))
}

function matchesAny(description: string, matchers: string[]) {
  if (matchers.length === 0) return false
  const d = (description ?? '').toUpperCase()
  return matchers.some((m) => {
    const needle = (m ?? '').trim().toUpperCase()
    return needle.length >= 3 && d.includes(needle)
  })
}

export type FlowEstimate = {
  /** Median weekly money in, excluding financing and internal transfers. */
  typicalInflow: number
  /** Lower-quartile week — what to plan on when trade is slow. */
  cautiousInflow: number
  /** Median weekly money out. */
  typicalOutflow: number
  weeksObserved: number
}

/**
 * Robust weekly inflow/outflow estimates.
 *
 * Median and lower quartile are used rather than means precisely because this
 * ledger contains six-figure one-off events (see rule 4 above).
 */
export function estimateWeeklyFlow(weeks: WeeklyFlow[]): FlowEstimate {
  const inflows = weeks.map((w) => w.inflow)
  const outflows = weeks.map((w) => w.outflow)
  return {
    typicalInflow: money(quantile(inflows, 0.5)),
    cautiousInflow: money(quantile(inflows, 0.25)),
    typicalOutflow: money(quantile(outflows, 0.5)),
    weeksObserved: weeks.length,
  }
}

/**
 * Share of a normal week's income that lands on each weekday, keyed 1..7.
 *
 * This matters because money does not arrive evenly: card settlements skip
 * weekends and the weekend's takings batch into Monday. A flat 1/7th split
 * would invent income on Sunday and understate Monday.
 */
export function buildDayOfWeekProfile(
  rows: LedgerRow[],
  options: { operatingAccounts: string[] },
): { shares: Record<number, number>; hasProfile: boolean } {
  const totals: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }
  let sum = 0

  for (const row of rows) {
    if (!row.date) continue
    if (classifyFlow(row, options.operatingAccounts) !== 'in') continue
    const dow = isoDayOfWeek(row.date)
    totals[dow] += row.amount
    sum += row.amount
  }

  if (sum <= 0) {
    // No usable history. Signal it instead of fabricating a distribution.
    return { shares: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }, hasProfile: false }
  }

  const shares: Record<number, number> = {}
  for (let d = 1; d <= 7; d++) shares[d] = totals[d] / sum
  return { shares, hasProfile: true }
}

export type ForecastDay = {
  date: string
  /** Expected money in on the cautious (slow-week) basis. */
  cautiousIn: number
  /** Expected money in on a typical week. */
  typicalIn: number
  /** Everything expected to leave that day. */
  moneyOut: number
  /** Named items making up `moneyOut`, for the "why" explanation. */
  items: { label: string; amount: number }[]
  /** Running balance on the cautious basis — the one used for the headline. */
  cautiousBalance: number
  /** Running balance on a typical week. */
  typicalBalance: number
  /** True when the cautious balance ends the day under the reserve. */
  breachesReserve: boolean
}

export type CapacityInput = {
  /** Raw cash across operating accounts. NOT the spendable figure. */
  cashOnHand: number
  minCashReserve: number
  today: string
  estimate: FlowEstimate
  shares: Record<number, number>
  /**
   * Items with a known date: scheduled obligations, written checks that have
   * not cleared, and logged ACH drafts. These are additive to the estimated
   * baseline ONLY because `buildWeeklyFlows` was told to exclude them from it.
   */
  datedOutflows: DatedOutflow[]
  /** Baseline weekly spend to spread across the week, excluding dated items. */
  baselineWeeklyOutflow: number
}

export type CapacityResult = {
  days: ForecastDay[]
  /** Headline: spendable today without dipping under the reserve this week. */
  safeToSpendToday: number
  /** A sustainable daily pace, not a promise. */
  perDayAllowance: number
  /** Lowest cautious balance across the window. */
  lowestBalance: number
  lowestBalanceDate: string
  /** True if the cautious projection dips under the reserve at any point. */
  breachesReserve: boolean
  reserveShortfall: number
}

/**
 * Build the 7-day table and the headline number.
 *
 * Starting point is RAW cash on hand, never the "spendable" figure that already
 * has outstanding checks netted out of it. Outstanding items are then
 * subtracted on the dates they are expected to land. Starting from the netted
 * figure AND subtracting them again would charge every unclearead check twice.
 */
export function deriveSpendingCapacity(input: CapacityInput): CapacityResult {
  const {
    cashOnHand,
    minCashReserve,
    today,
    estimate,
    shares,
    datedOutflows,
    baselineWeeklyOutflow,
  } = input

  const dated = new Map<string, DatedOutflow[]>()
  for (const item of datedOutflows) {
    if (!item.date || item.amount <= 0) continue
    // Anything already overdue is treated as landing today: the money is still
    // owed, and pretending it left in the past would overstate today's cash.
    const key = item.date < today ? today : item.date
    dated.set(key, [...(dated.get(key) ?? []), item])
  }

  const baselineDaily = baselineWeeklyOutflow > 0 ? baselineWeeklyOutflow / 7 : 0

  const days: ForecastDay[] = []
  let cautiousBalance = cashOnHand
  let typicalBalance = cashOnHand
  let lowestBalance = Number.POSITIVE_INFINITY
  let lowestBalanceDate = today

  for (let i = 0; i < 7; i++) {
    const date = addDays(today, i)
    const dow = isoDayOfWeek(date)
    const share = shares[dow] ?? 0

    const cautiousIn = money(estimate.cautiousInflow * share)
    const typicalIn = money(estimate.typicalInflow * share)

    const items = [...(dated.get(date) ?? [])].map((d) => ({
      label: d.label,
      amount: money(d.amount),
    }))
    const datedTotal = items.reduce((s, it) => s + it.amount, 0)

    if (baselineDaily > 0) {
      items.push({ label: 'Day-to-day running costs', amount: money(baselineDaily) })
    }
    const moneyOut = money(datedTotal + baselineDaily)

    cautiousBalance = money(cautiousBalance + cautiousIn - moneyOut)
    typicalBalance = money(typicalBalance + typicalIn - moneyOut)

    if (cautiousBalance < lowestBalance) {
      lowestBalance = cautiousBalance
      lowestBalanceDate = date
    }

    days.push({
      date,
      cautiousIn,
      typicalIn,
      moneyOut,
      items,
      cautiousBalance,
      typicalBalance,
      breachesReserve: cautiousBalance < minCashReserve,
    })
  }

  if (!Number.isFinite(lowestBalance)) lowestBalance = cashOnHand

  // The headline uses the LOWEST point in the week, not the closing balance. A
  // strong Friday must never paper over a Wednesday that cannot cover payroll.
  const headroom = lowestBalance - minCashReserve
  const safeToSpendToday = money(Math.max(0, headroom))

  return {
    days,
    safeToSpendToday,
    perDayAllowance: money(safeToSpendToday / 7),
    lowestBalance,
    lowestBalanceDate,
    breachesReserve: headroom < 0,
    reserveShortfall: money(Math.max(0, -headroom)),
  }
}

/**
 * How trustworthy the projection is, so the UI can be honest instead of
 * confidently wrong. Anything other than 'ok' should suppress the headline.
 */
export type CapacityConfidence =
  | { level: 'ok' }
  | { level: 'insufficient-history'; weeksObserved: number }
  | { level: 'no-income-pattern' }
  | { level: 'stale-data'; daysStale: number }

export function assessConfidence(options: {
  weeksObserved: number
  hasProfile: boolean
  lastLedgerDate: string
  today: string
  minWeeks?: number
  maxStaleDays?: number
}): CapacityConfidence {
  const { weeksObserved, hasProfile, lastLedgerDate, today } = options
  const minWeeks = options.minWeeks ?? 4
  const maxStaleDays = options.maxStaleDays ?? 10

  if (weeksObserved < minWeeks) return { level: 'insufficient-history', weeksObserved }
  if (!hasProfile) return { level: 'no-income-pattern' }

  if (lastLedgerDate) {
    const daysStale = Math.round(
      (parseDate(today).getTime() - parseDate(lastLedgerDate).getTime()) / 86_400_000,
    )
    if (daysStale > maxStaleDays) return { level: 'stale-data', daysStale }
  }
  return { level: 'ok' }
}

// ---------------------------------------------------------------------------
// Shared assembly
// ---------------------------------------------------------------------------

/**
 * Everything the assembly needs, as plain data. No database handles, so both the
 * request-scoped loader and the offline verification script can call it.
 */
export type AssembleInput = {
  accounts: { account_name?: string | null; account_type?: string | null; current_balance?: number | string | null }[]
  rows: LedgerRow[]
  /** Obligations already resolved to a concrete due date. */
  obligations: { id?: string | number | null; effectiveDueDate?: string | null; amount: number; vendorName?: string | null; obligationName?: string | null }[]
  /** Uncleared checks and ACH drafts. */
  payments: { obligationId?: string | null; payeeName?: string | null; checkNumber?: string | null; paymentDate: string; amount: number; status: string }[]
  minCashReserve: number
  today: string
}

/**
 * Turn live records into a spending-capacity result.
 *
 * This exists because the verification script previously re-implemented this
 * assembly and silently drifted from it: it omitted `datedOutflows` and
 * `excludeMatchers`, so it reported a different weekly gap and a different
 * safe-to-spend figure than the page actually showed. A proof that does not
 * exercise the shipped path proves nothing, so there is now exactly one
 * implementation and both callers use it.
 */
export function assembleCapacity(input: AssembleInput) {
  const { accounts, rows, obligations, payments, minCashReserve, today } = input
  const money = (n: number) => Math.round(n * 100) / 100

  // Only accounts holding spendable cash. A line of credit is borrowing capacity,
  // not money in hand, and must never inflate what is safe to spend.
  const operating = accounts.filter(
    (a) => !/credit|loan|card/i.test(`${a.account_type ?? ''} ${a.account_name ?? ''}`),
  )
  const cashOnHand = money(
    operating.reduce((s, a) => s + Number(a.current_balance ?? 0), 0),
  )

  const operatingAccounts = [
    ...new Set(
      rows
        .map((r) => r.accountName)
        .filter((n) => n && !/amex|american express|credit|card|loan/i.test(n)),
    ),
  ]

  const lastLedgerDate = rows.reduce((max, r) => (r.date > max ? r.date : max), '')

  const datedOutflows: DatedOutflow[] = []
  const outstanding = payments.filter((p) => p.status === 'outstanding' && p.amount > 0)

  // An obligation that already has a payment written against it must not also be
  // charged on its due date; the written payment is the more concrete fact.
  const coveredObligationIds = new Set(
    outstanding.map((p) => p.obligationId).filter((id): id is string => Boolean(id)),
  )

  const obligationLabels = new Map<string, string>()
  for (const o of obligations) {
    const label = o.vendorName || o.obligationName || 'Scheduled obligation'
    if (o.id) obligationLabels.set(String(o.id), label)
    if (!o.effectiveDueDate || o.amount <= 0) continue
    if (o.id && coveredObligationIds.has(String(o.id))) continue
    datedOutflows.push({ date: o.effectiveDueDate, amount: Number(o.amount), label })
  }

  for (const p of outstanding) {
    const name =
      p.payeeName ||
      (p.obligationId ? obligationLabels.get(String(p.obligationId)) : '') ||
      'Uncleared payment'
    datedOutflows.push({
      date: p.paymentDate,
      amount: Number(p.amount),
      label: p.checkNumber ? `${name} (check ${p.checkNumber})` : name,
    })
  }

  // Vendors charged as dated items are removed from the estimated baseline, or
  // the same bill is subtracted twice.
  const windowEnd = addDays(today, 7)
  const excludeMatchers = [
    ...new Set(
      datedOutflows
        .filter((d) => d.date >= today && d.date <= windowEnd)
        .map((d) => d.label.replace(/\s*\(check[^)]*\)/i, '').trim())
        .filter((l) => l.length >= 3),
    ),
  ]

  const weeks = buildWeeklyFlows(rows, { operatingAccounts, today, excludeMatchers })
  const estimate = estimateWeeklyFlow(weeks)
  const { shares, hasProfile } = buildDayOfWeekProfile(rows, { operatingAccounts })

  const result = deriveSpendingCapacity({
    cashOnHand,
    minCashReserve,
    today,
    estimate,
    shares,
    datedOutflows,
    baselineWeeklyOutflow: estimate.typicalOutflow,
  })

  const confidence = assessConfidence({
    weeksObserved: estimate.weeksObserved,
    hasProfile,
    lastLedgerDate,
    today,
  })

  return {
    result,
    estimate,
    confidence,
    shares,
    datedOutflows,
    cashOnHand,
    operatingAccounts,
    lastLedgerDate,
  }
}
