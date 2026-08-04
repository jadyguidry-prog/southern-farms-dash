// `card-activity` is pure (no db, no clock), so importing it keeps this module pure too.
import { planCardPayments } from './card-activity'

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
  /**
   * Days to project while looking for the low point and reserve breaches. Defaults to 7.
   *
   * Deliberately separate from `nearTermDays`: the horizon must be long enough to contain
   * a card statement due date (~15 days out here), because an outflow beyond the last
   * projected day is invisible no matter how large it is.
   */
  horizonDays?: number
  /**
   * Days the "safe to spend" headline is allowed to consider. Defaults to 7.
   *
   * This is NOT the horizon. If the headline used the full horizon, a known payoff three
   * weeks out would drag today's number toward zero and the honest answer ("you can spend
   * this now, and there is a cliff on the 18th") would collapse into a single misleading
   * $0. Two questions, two windows, both reported.
   */
  nearTermDays?: number
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
  /**
   * The low point within the NEAR-TERM window only — what the headline is solved against.
   * Reported alongside the horizon low point so the two standards are never confused,
   * the way a ladder marked "Tight" once sat beside a headline of $0 with no explanation.
   */
  nearTermLowestBalance: number
  /** Days of projection actually produced. */
  horizonDays: number
  /** Days the headline considered. */
  nearTermDays: number
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
    horizonDays = 7,
    nearTermDays = 7,
  } = input

  // The headline can never consider more than what was actually projected.
  const nearTerm = Math.max(1, Math.min(nearTermDays, horizonDays))

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
  let nearTermLowestBalance = Number.POSITIVE_INFINITY

  // Always project far enough to include every dated outflow. A known payment sitting one
  // day past the horizon is invisible, which is the exact failure being fixed here — so
  // the horizon stretches to cover it rather than trusting the setting to be big enough.
  const furthestDated = [...dated.keys()].sort().at(-1) ?? today
  let span = Math.max(1, horizonDays)
  while (addDays(today, span - 1) < furthestDated && span < 400) span++

  for (let i = 0; i < span; i++) {
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

    if (i < nearTerm && cautiousBalance < nearTermLowestBalance) {
      nearTermLowestBalance = cautiousBalance
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
  if (!Number.isFinite(nearTermLowestBalance)) nearTermLowestBalance = cashOnHand

  // The headline uses the LOWEST point in the NEAR-TERM window, not the closing balance. A
  // strong Friday must never paper over a Wednesday that cannot cover payroll.
  //
  // It deliberately does NOT use the full-horizon low point. Spending is a decision about
  // now; a payoff three weeks out is a scheduling fact, and folding it into today's
  // headline would report $0 spendable while $5k sits in the account — technically
  // defensible, useless as advice, and the kind of number that gets ignored. The horizon
  // low point drives `breachesReserve` instead, so the warning still fires.
  const headroom = nearTermLowestBalance - minCashReserve
  const safeToSpendToday = money(Math.max(0, headroom))

  // The BREACH warning is judged across the FULL horizon, not the headline window. This is
  // the whole point of separating them: a $9.9k payoff on day 15 must raise the alarm even
  // though it is correctly excluded from what is spendable today. Using near-term headroom
  // here would restore the original blind spot with extra steps.
  const horizonHeadroom = lowestBalance - minCashReserve

  return {
    days,
    safeToSpendToday,
    perDayAllowance: money(safeToSpendToday / nearTerm),
    lowestBalance,
    lowestBalanceDate,
    breachesReserve: horizonHeadroom < 0,
    reserveShortfall: money(Math.max(0, -horizonHeadroom)),
    nearTermLowestBalance,
    horizonDays: span,
    nearTermDays: nearTerm,
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
  /**
   * Credit cards, so a statement payoff can be charged on its DUE DATE instead of
   * disappearing into an averaged daily outflow. Optional: omitting it preserves the
   * previous behaviour exactly, which keeps existing callers and tests honest.
   */
  cards?: {
    accountName: string
    closedAt: string | null
    balanceOwed: number | null
    statementDueDate: string | null
    /** Ledger descriptor of a payoff TO this card, e.g. "AMEX EPAYMENT". */
    paymentDescriptionMatch: string | null
  }[]
  /**
   * How many days ahead to project when hunting for the cash low point. Defaults to the
   * old 7 so nothing changes for callers that do not pass it.
   */
  horizonDays?: number
  /** Length of the near-term "safe to spend" window. Defaults to 7. */
  nearTermDays?: number
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
  const {
    accounts,
    rows,
    obligations,
    payments,
    minCashReserve,
    today,
    cards = [],
    horizonDays = 7,
    nearTermDays = 7,
  } = input
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

  // ---- Credit-card payoffs, charged on the statement due date ----
  //
  // A card payoff is one large monthly event. Averaging it into a daily figure hides the
  // cliff: ~$9.9k becomes ~$300/day, which looks like nothing on the day it actually
  // clears. These are added as dated outflows so the trough is real.
  const cardPlans = planCardPayments(cards, today)
  const cardPayments = cardPlans.filter((p) => p.blockedReason === null)
  const blockedCardPayments = cardPlans.filter((p) => p.blockedReason !== null)

  for (const p of cardPayments) {
    datedOutflows.push({
      date: p.dueDate,
      amount: p.amount,
      label: `${p.accountName} statement payment`,
    })
  }

  // Vendors charged as dated items are removed from the estimated baseline, or
  // the same bill is subtracted twice.
  const windowEnd = addDays(today, Math.max(nearTermDays, horizonDays))
  const excludeMatchers = [
    ...new Set(
      datedOutflows
        .filter((d) => d.date >= today && d.date <= windowEnd)
        .map((d) => d.label.replace(/\s*\(check[^)]*\)/i, '').trim())
        .filter((l) => l.length >= 3),
    ),
  ]

  // Card payoffs need a SEPARATE matcher list from the one above, for two reasons:
  //
  // 1. The label ("American Express ending 0-73009 statement payment") is not what the
  //    bank writes in the ledger ("AMEX EPAYMENT"), so label matching would never fire
  //    and every historical payoff would stay in the baseline — the double count.
  // 2. Historical payoffs must be excluded across the WHOLE history, not just inside the
  //    forecast window, because the baseline is a median of past weeks. A window filter
  //    is right for a one-off bill and wrong for a recurring monthly event.
  //
  // Only cards actually being forecast contribute a matcher. Excluding history for a card
  // whose payoff is NOT being charged forward would erase real spending from the
  // baseline and overstate available cash.
  const cardExcludeMatchers = [
    ...new Set(
      cardPayments
        .map(
          (p) =>
            cards.find((c) => c.accountName === p.accountName)?.paymentDescriptionMatch ?? '',
        )
        .filter((m) => m.length >= 3),
    ),
  ]

  const weeks = buildWeeklyFlows(rows, {
    operatingAccounts,
    today,
    excludeMatchers: [...excludeMatchers, ...cardExcludeMatchers],
  })
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
    horizonDays,
    nearTermDays,
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
    cardPayments,
    // Surfaced so the UI can say WHY a card is absent from the forecast. A card silently
    // missing from the projection is indistinguishable from one that owes nothing.
    blockedCardPayments,
  }
}
