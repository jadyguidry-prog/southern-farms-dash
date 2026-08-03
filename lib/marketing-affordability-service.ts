// Marketing Affordability Engine.
//
// Answers one question: how much MORE marketing can the business safely afford
// this month without dropping below its cash reserve?
//
// This is deliberately not a "percent of revenue" budget. A percentage ignores
// whether the money is actually in the bank. The revenue percentage is only the
// starting point; it is then adjusted for cash position, revenue trend,
// seasonality, payroll load and debt, and finally HARD CLAMPED to what the cash
// position can genuinely cover. If the clamp binds, the recommendation is the
// clamp — the engine will report $0 rather than a comfortable-looking number it
// cannot justify.
//
// Every pure function below is DB-free so the money math is unit testable.
// Only `getMarketingAffordability` touches Supabase.

import { createClient } from '@/lib/supabase/server'
import { canonicalCategory, type CategoryAliasMap } from '@/lib/categories'
// Imported for this module's OWN use (windowSum etc.) AND re-exported below so
// existing importers of `addMonths` from this path keep working. A bare
// `export { addMonths } from ...` creates a binding for importers only, not a
// local one the module body can call — which is exactly what broke here.
import { addMonths } from '@/lib/month-key'
import { SPEND_TYPES, SPEND_OFFSET_TYPES, type TransactionType } from '@/lib/transactions'
import { fetchAllPages } from '@/lib/paginate'
import { isGenericDescription } from '@/lib/transaction-groups'
import {
  deriveMonthlyCashFlow,
  monthLabel,
  type CashFlowInputRow,
} from '@/lib/cash-flow-service'

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

/** The canonical category name that identifies marketing spend. */
export const MARKETING_CATEGORY = 'Marketing'

/** Average days in a month, for converting monthly figures to daily burn. */
export const DAYS_PER_MONTH = 30.44

export type MarketingTxnRow = {
  id: string
  transactionDate: string
  description: string
  amount: number
  transactionType: string
  reviewStatus: string
  expenseCategory: string
  vendorId: string | null
}

/* ------------------------------------------------------------------ */
/* Step 1 — Current marketing spend                                    */
/* ------------------------------------------------------------------ */

export type MarketingSpendRow = {
  date: string
  amount: number
  description: string
  /** How this row was identified as marketing. */
  via: 'category' | 'vendor'
}

export type CurrentMarketingSpend = {
  /** Spend inside the most recent calendar month that has any marketing rows. */
  currentMonth: number
  /** `YYYY-MM` the `currentMonth` figure refers to, null when never spent. */
  currentMonthKey: string | null
  /** Mean monthly spend across the last 3 / 12 calendar months. */
  avg3Month: number
  avg12Month: number
  /**
   * The headline "what you typically spend" figure: total marketing divided by
   * the calendar months from the first charge to the last, gaps included.
   *
   * Unlike the trailing-window averages, this is anchored on the data itself, not
   * on today's date. When the bank feed lags (recent months empty), a trailing
   * 3-month average collapses toward zero — that is the "$16/month" bug — while
   * this keeps reporting the real long-run rate.
   */
  typicalMonthly: number
  /** Calendar months from first to last marketing charge, inclusive. */
  activeMonthsSpanned: number
  /** Whole calendar months since the most recent marketing charge. */
  monthsSinceLastSpend: number | null
  /** Total across the trailing 12 calendar months. */
  annualTotal: number
  /** Total across every row ever recorded. */
  lifetimeTotal: number
  rows: MarketingSpendRow[]
  /** Per-month series, oldest first, for the trend chart. */
  monthly: { monthKey: string; amount: number }[]
  /** Distinct payees, so the owner can see WHICH channels are running. */
  channels: { name: string; amount: number; count: number }[]
}

export type LapsedChannel = {
  channel: string
  lastDate: string
  monthsSinceLastCharge: number
  /** Mean per active month while the channel WAS running. */
  typicalMonthly: number
}

export type SpendReconciliation = {
  /**
   * Channels with no charge in the trailing window. If the owner says these are
   * still running, the money is leaving by a route the bank feed cannot attribute
   * (usually a check), not stopping.
   */
  lapsed: LapsedChannel[]
  /**
   * Outflows whose description carries no payee at all — `CHECK`, `DEPOSIT` and
   * friends. Structurally unattributable: the bank export has no payee, memo or
   * check-number field, so no rule can ever categorize these. Any recurring
   * marketing paid this way is invisible to every figure on the page, and that
   * has to be said rather than reported as "marketing stopped".
   */
  unattributable: { total: number; count: number; monthlyAverage: number }
  /**
   * Payee-less rows the owner has ALREADY identified on the Check Resolution
   * screen. These are excluded from `unattributable` above — counting them as
   * unknown would tell the owner their own completed work does not exist.
   */
  resolved: { total: number; count: number }
  /** True when spend is recent enough that the trailing average is meaningful. */
  hasRecentActivity: boolean
}

/** What the owner recorded for a payee-less row, keyed by transaction id. */
export type ResolvedPayee = { payee: string; category: string }

/**
 * Explain the gap between marketing the owner knows they pay and marketing the
 * ledger can see.
 *
 * The trailing average is arithmetically correct but can still be misleading: a
 * channel that ran for months and then vanished from the feed looks like it
 * stopped, when in practice it moved to a payment method that carries no payee.
 */
export function reconcileKnownSpend(
  rows: MarketingTxnRow[],
  marketingVendorIds: Set<string>,
  today: Date,
  lapsedAfterMonths = 2,
  aliases: CategoryAliasMap = {},
  resolutions: Map<string, ResolvedPayee> = new Map(),
): SpendReconciliation {
  const thisMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  const perChannel = new Map<string, { last: string; months: Set<string>; total: number }>()
  let unTotal = 0
  let unCount = 0
  const unMonths = new Set<string>()
  let resTotal = 0
  let resCount = 0

  for (const r of rows) {
    if (r.reviewStatus === 'excluded') continue
    if (!SPEND_TYPES.includes(r.transactionType as never)) continue
    const monthKey = monthKeyOf(r.transactionDate)
    if (!monthKey) continue

    // Reuse the generic-payee rule already proven in lib/transaction-groups.ts
    // rather than inventing a second definition of "no payee".
    let description = r.description
    if (isGenericDescription(description)) {
      const fix = resolutions.get(r.id)
      if (!fix) {
        unTotal += Math.abs(r.amount)
        unCount += 1
        unMonths.add(monthKey)
        continue
      }
      // The owner already said who this was. Treat the resolved payee and
      // category as the row's identity from here on, so a check resolved to a
      // marketing payee is counted as marketing rather than reported as unknown.
      resTotal += Math.abs(r.amount)
      resCount += 1
      description = fix.payee || description
      const resolvedCategory = canonicalCategory(fix.category, aliases)
      const resolvedIsMarketing =
        resolvedCategory === MARKETING_CATEGORY ||
        MARKETING_PATTERNS.some((p) => p.confident && p.test.test(description.toUpperCase()))
      if (!resolvedIsMarketing) continue
      const resolvedName = marketingChannelName(description)
      const re = perChannel.get(resolvedName) ?? { last: '', months: new Set<string>(), total: 0 }
      const resolvedDate = r.transactionDate.slice(0, 10)
      if (resolvedDate > re.last) re.last = resolvedDate
      re.months.add(monthKey)
      re.total += Math.abs(r.amount)
      perChannel.set(resolvedName, re)
      continue
    }

    const category = canonicalCategory(r.expenseCategory, aliases)
    const isMarketing =
      category === MARKETING_CATEGORY ||
      (r.vendorId != null && marketingVendorIds.has(r.vendorId)) ||
      MARKETING_PATTERNS.some((p) => p.confident && p.test.test(description.toUpperCase()))
    if (!isMarketing) continue

    const name = marketingChannelName(description)
    const e = perChannel.get(name) ?? { last: '', months: new Set<string>(), total: 0 }
    const date = r.transactionDate.slice(0, 10)
    if (date > e.last) e.last = date
    e.months.add(monthKey)
    e.total += Math.abs(r.amount)
    perChannel.set(name, e)
  }

  const monthsBetween = (from: string, to: string) => {
    let n = 0
    let cursor = from
    while (cursor < to && n < 600) {
      cursor = addMonths(cursor, 1)
      n += 1
    }
    return n
  }

  const lapsed: LapsedChannel[] = []
  for (const [channel, e] of perChannel) {
    const gap = monthsBetween(monthKeyOf(e.last), thisMonthKey)
    if (gap < lapsedAfterMonths) continue
    lapsed.push({
      channel,
      lastDate: e.last,
      monthsSinceLastCharge: gap,
      typicalMonthly: e.total / Math.max(1, e.months.size),
    })
  }
  lapsed.sort((a, b) => b.typicalMonthly - a.typicalMonthly)

  return {
    lapsed,
    unattributable: {
      total: unTotal,
      count: unCount,
      monthlyAverage: unMonths.size > 0 ? unTotal / unMonths.size : 0,
    },
    resolved: { total: resTotal, count: resCount },
    hasRecentActivity: [...perChannel.values()].some(
      (e) => monthsBetween(monthKeyOf(e.last), thisMonthKey) < lapsedAfterMonths,
    ),
  }
}

/** `YYYY-MM` for a date string, or '' when unparseable. */
function monthKeyOf(date: string): string {
  return /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : ''
}

// `addMonths` now lives in the pure `@/lib/month-key` module (imported above): it
// is a clock-free date helper with no server dependencies, and importing it FROM
// here previously dragged this server service — and `next/headers` — into the
// client bundle the moment a client component transitively reached it. Re-exported
// so existing importers of this path keep working.
export { addMonths }

/**
 * Collapse a card descriptor to a readable channel name.
 *
 * Facebook's charges arrive as `FACEBK *BBMFW9H6N2 650-543-7818 CA` — a unique
 * token per charge, so grouping on the raw string would report 18 separate
 * "channels" for what is one advertising account.
 */
/**
 * Description patterns that identify a marketing channel.
 *
 * Single source of truth, shared by `marketingChannelName` (naming rows already
 * known to be marketing) and `findUncategorizedMarketing` (spotting marketing
 * that was never categorized). Keeping one table stops the two from drifting.
 *
 * `confident` marks patterns that are advertising and essentially nothing else.
 * Only those are used to flag uncategorized spend, because suggesting a
 * miscategorization is only useful if it is very likely to be right — Adobe or a
 * domain renewal is just as plausibly Software.
 */
const MARKETING_PATTERNS: { test: RegExp; channel: string; confident: boolean }[] = [
  // Meta bills direct as `FACEBK *<token>`, but also arrives routed through
  // PayPal as `PAYPAL INST XFER METAPLATFOR` — no space, so a `META PLATFORMS`
  // pattern misses it entirely.
  {
    test: /FACEBK|FACEBOOK|META\s*PLAT|METAPLAT|META ADS|INSTAGRAM/,
    channel: 'Facebook / Meta Ads',
    confident: true,
  },
  { test: /GOOGLE\s*ADS|ADWORDS/, channel: 'Google Ads', confident: true },
  // TikTok bills as `TIKTOK PROMOTE ...` / `TIKTOK ADS`. Confident: the only
  // TikTok charges a store like this sees are paid promotion.
  { test: /TIKTOK|TIK TOK/, channel: 'TikTok Ads', confident: true },
  {
    test: /MAILCHIMP|KLAVIYO|CONSTANT CONTACT|SENDGRID/,
    channel: 'Email marketing',
    confident: true,
  },
  {
    test: /TEXTEDLY|SIMPLETEXTING|ATTENTIVE/,
    channel: 'SMS marketing',
    confident: true,
  },
  // `OUTD`/`OUTDOOR` is the trade term for billboards, so a vendor like
  // `BAYOU SIGNS OUTD` is outdoor advertising — NOT the signage/printing bucket
  // below. It matched there first and the owner did not recognise their own
  // billboard spend, so this must stay ahead of the signage pattern.
  {
    test: /BILLBOARD|LAMAR|OUTFRONT|\bOUTD\b|\bOUTDOOR\b/,
    channel: 'Billboards / outdoor',
    confident: true,
  },
  {
    test: /BROADCAS|\bRADIO\b|CABLE ADVERT/,
    channel: 'Radio / TV advertising',
    confident: true,
  },
  // `\bSIGN` so DESIGN does not match. VISTAPRINT is named explicitly because it
  // is one word — a `\bPRINTING\b` pattern alone misses it.
  {
    test: /\bSIGNS?\b|\bSIGNAGE\b|\bBANNER|\bPRINTING\b|VISTAPRINT|VISTA PRINT/,
    channel: 'Signage / printing',
    confident: true,
  },
  { test: /\bYELP\b|THUMBTACK/, channel: 'Directory listings', confident: true },
  { test: /PHOTO/, channel: 'Photography', confident: false },
  { test: /CANVA|ADOBE/, channel: 'Design software', confident: false },
  {
    test: /GODADDY|NAMECHEAP|SQUARESPACE|WIX|WORDPRESS|SHOPIFY/,
    channel: 'Website / domain',
    confident: false,
  },
]

export function marketingChannelName(description: string): string {
  const d = description.trim().toUpperCase()
  for (const p of MARKETING_PATTERNS) {
    if (p.test.test(d)) return p.channel
  }
  // Fall back to the leading words, which is enough to identify an agency or a
  // local vendor without exposing a transaction reference as a channel.
  return description.trim().split(/\s{2,}|\s(?=\d)/)[0]?.slice(0, 40) || 'Other marketing'
}

/**
 * Marketing spend, identified two ways: the transaction's own category, or the
 * category on its linked vendor. Vendor-level classification matters because a
 * vendor marked Marketing should count even when an individual row was never
 * categorized.
 */
export function summarizeCurrentMarketingSpend(
  rows: MarketingTxnRow[],
  marketingVendorIds: Set<string>,
  today: Date,
  aliases: CategoryAliasMap = {},
): CurrentMarketingSpend {
  const matched: MarketingSpendRow[] = []

  for (const r of rows) {
    if (r.reviewStatus === 'excluded') continue
    // Only outflows. A refund against an ad account reduces spend.
    const isSpend = SPEND_TYPES.includes(r.transactionType as never)
    const isOffset = SPEND_OFFSET_TYPES.includes(r.transactionType as never)
    if (!isSpend && !isOffset) continue

    const category = canonicalCategory(r.expenseCategory, aliases)
    const byCategory = category === MARKETING_CATEGORY
    const byVendor = r.vendorId != null && marketingVendorIds.has(r.vendorId)
    if (!byCategory && !byVendor) continue

    const key = monthKeyOf(r.transactionDate)
    if (!key) continue

    matched.push({
      date: r.transactionDate.slice(0, 10),
      amount: isOffset ? -Math.abs(r.amount) : Math.abs(r.amount),
      description: r.description,
      via: byCategory ? 'category' : 'vendor',
    })
  }

  const byMonth = new Map<string, number>()
  for (const r of matched) {
    const k = monthKeyOf(r.date)
    byMonth.set(k, (byMonth.get(k) ?? 0) + r.amount)
  }

  const monthly = [...byMonth]
    .map(([monthKey, amount]) => ({ monthKey, amount }))
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey))

  const thisMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`

  // Averages run over a fixed window of CALENDAR months, not over the months
  // that happen to contain rows. Dividing by the number of active months would
  // report a $200 average for a business that advertised once all year.
  const windowSum = (months: number) => {
    let total = 0
    for (let i = 0; i < months; i += 1) {
      total += byMonth.get(addMonths(thisMonthKey, -i)) ?? 0
    }
    return total
  }

  const annualTotal = windowSum(12)
  const latestWithSpend = [...monthly].reverse().find((m) => m.amount !== 0) ?? null

  // Stale-proof "typical monthly": total spread over the calendar months the
  // charges actually span, first to last inclusive. Anchored on the data, so a
  // lagging bank feed cannot drag it toward zero the way trailing windows do.
  const activeKeys = monthly.filter((m) => m.amount !== 0).map((m) => m.monthKey)
  const firstActive = activeKeys[0] ?? null
  const lastActive = activeKeys[activeKeys.length - 1] ?? null
  let activeMonthsSpanned = 0
  if (firstActive && lastActive) {
    let cursor = firstActive
    activeMonthsSpanned = 1
    while (cursor < lastActive && activeMonthsSpanned < 600) {
      cursor = addMonths(cursor, 1)
      activeMonthsSpanned += 1
    }
  }
  const lifetimeTotal = matched.reduce((s, r) => s + r.amount, 0)
  const typicalMonthly = activeMonthsSpanned > 0 ? lifetimeTotal / activeMonthsSpanned : 0

  let monthsSinceLastSpend: number | null = null
  if (lastActive) {
    let cursor = lastActive
    monthsSinceLastSpend = 0
    while (cursor < thisMonthKey && monthsSinceLastSpend < 600) {
      cursor = addMonths(cursor, 1)
      monthsSinceLastSpend += 1
    }
  }

  const channelMap = new Map<string, { amount: number; count: number }>()
  for (const r of matched) {
    const name = marketingChannelName(r.description)
    const e = channelMap.get(name) ?? { amount: 0, count: 0 }
    e.amount += r.amount
    e.count += 1
    channelMap.set(name, e)
  }

  return {
    currentMonth: byMonth.get(thisMonthKey) ?? 0,
    currentMonthKey: latestWithSpend?.monthKey ?? null,
    avg3Month: windowSum(3) / 3,
    avg12Month: annualTotal / 12,
    typicalMonthly,
    activeMonthsSpanned,
    monthsSinceLastSpend,
    annualTotal,
    lifetimeTotal,
    rows: matched.sort((a, b) => b.date.localeCompare(a.date)),
    monthly,
    channels: [...channelMap]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.amount - a.amount),
  }
}

export type SuspectedMarketingChannel = {
  channel: string
  amount: number
  count: number
  sampleDescription: string
}

export type UncategorizedMarketing = {
  channels: SuspectedMarketingChannel[]
  total: number
  /**
   * Spread over the CALENDAR months from the first to the last charge, matching
   * the convention in `summarizeCurrentMarketingSpend`. Dividing by the number of
   * months that happen to contain a charge overstates the rate whenever the
   * ledger has gaps — which it does.
   */
  impliedMonthly: number
  /** Calendar months from first to last charge inclusive, gaps included. */
  monthsSpanned: number
  /** Months in that span with no charge at all — a sign of missing data. */
  monthsWithoutCharges: number
  firstMonth: string | null
  lastMonth: string | null
}

/**
 * Advertising charges that were never categorized as Marketing.
 *
 * This is the usual reason reported marketing looks far too low: the money left
 * the bank, but under a blank category, so every marketing figure excludes it.
 * These are reported as suggestions for the owner to confirm — never silently
 * counted as marketing, because guessing a category would corrupt the ledger
 * the rest of the app trusts.
 */
export function findUncategorizedMarketing(
  rows: MarketingTxnRow[],
  marketingVendorIds: Set<string>,
  aliases: CategoryAliasMap = {},
): UncategorizedMarketing {
  const map = new Map<string, SuspectedMarketingChannel>()
  const months = new Set<string>()
  let total = 0

  for (const r of rows) {
    if (r.reviewStatus === 'excluded') continue
    if (!SPEND_TYPES.includes(r.transactionType as never)) continue

    // Skip anything already counted, so this only ever reports NEW money.
    const category = canonicalCategory(r.expenseCategory, aliases)
    if (category === MARKETING_CATEGORY) continue
    if (r.vendorId != null && marketingVendorIds.has(r.vendorId)) continue

    const d = r.description.trim().toUpperCase()
    const hit = MARKETING_PATTERNS.find((p) => p.confident && p.test.test(d))
    if (!hit) continue

    const key = monthKeyOf(r.transactionDate)
    if (key) months.add(key)

    const amount = Math.abs(r.amount)
    total += amount
    const e =
      map.get(hit.channel) ??
      { channel: hit.channel, amount: 0, count: 0, sampleDescription: r.description }
    e.amount += amount
    e.count += 1
    map.set(hit.channel, e)
  }

  // Calendar span, not `months.size`. The same trap the averages above already
  // avoid: $5,962 spread over 5 active months reads as $1,192/mo, but those
  // charges span 7 calendar months, so the honest rate is $852/mo.
  const seen = [...months].sort()
  const firstMonth = seen[0] ?? null
  const lastMonth = seen[seen.length - 1] ?? null
  let monthsSpanned = 0
  if (firstMonth && lastMonth) {
    let cursor = firstMonth
    monthsSpanned = 1
    while (cursor < lastMonth && monthsSpanned < 600) {
      cursor = addMonths(cursor, 1)
      monthsSpanned += 1
    }
  }

  return {
    channels: [...map.values()].sort((a, b) => b.amount - a.amount),
    total,
    impliedMonthly: monthsSpanned > 0 ? total / monthsSpanned : 0,
    monthsSpanned,
    monthsWithoutCharges: Math.max(0, monthsSpanned - months.size),
    firstMonth,
    lastMonth,
  }
}

/* ------------------------------------------------------------------ */
/* Step 2 — Available operating cash                                   */
/* ------------------------------------------------------------------ */

export type CashDeduction = {
  label: string
  amount: number
  /** Where the figure came from, shown in the UI so nothing looks invented. */
  basis: string
}

export type AvailableOperatingCash = {
  cashOnHand: number
  minCashReserve: number
  /** Receivables genuinely expected to land, placeholders removed. */
  expectedReceivables: number
  /**
   * Sales the business typically collects in a month, from complete months of
   * history. This is the line that was missing entirely: the old projection
   * subtracted a month of costs while adding none of the money that comes in,
   * which for a store doing ~$77k/month is nonsensical.
   */
  expectedInflow: number
  inflowBasis: string
  /**
   * Everything that typically leaves the bank in a month — payroll, inventory,
   * rent, loans, all of it — averaged over complete months. Using the true total
   * outflow (rather than the short list of bills that happen to be on file) is
   * what keeps this honest: the bills table only ever captured a fraction.
   */
  expectedOutflow: number
  outflowBasis: string
  /**
   * Identifiable obligations that make up PART of `expectedOutflow`, listed for
   * reference so the owner can see the big pieces. These are NOT subtracted
   * again — they are already inside the outflow total.
   */
  deductions: CashDeduction[]
  totalDeductions: number
  /** Cash projected to remain at month end: cash + receivables + inflow − outflow. */
  projectedCash: number
  /** Projected cash minus the reserve. Negative means the reserve is breached. */
  availableOperatingCash: number
  /** Receivable rows ignored for being placeholders, surfaced for honesty. */
  excludedReceivables: { customer: string; amount: number; reason: string }[]
}

export type ReceivableInput = {
  customerName: string
  invoiceNumber: string | null
  amount: number
  amountPaid: number
  status: string
  notes: string | null
}

/**
 * A receivable that cannot be trusted as real money.
 *
 * The books contain a $5,000 row for customer "Unknown" with no invoice number
 * and a note calling itself a placeholder. Counting it would hand the owner
 * $5,000 of imaginary spending headroom, so it is excluded and reported.
 */
export function placeholderReceivableReason(r: ReceivableInput): string | null {
  const name = r.customerName.trim().toLowerCase()
  const notes = (r.notes ?? '').toLowerCase()
  if (/placeholder|example|test|dummy|sample/.test(notes)) {
    return 'Row is labelled a placeholder in its notes'
  }
  if (!name || name === 'unknown' || name === 'n/a') {
    return 'No real customer name'
  }
  if (!r.invoiceNumber || !r.invoiceNumber.trim()) {
    return 'No invoice number'
  }
  return null
}

export function computeAvailableOperatingCash(input: {
  cashOnHand: number
  minCashReserve: number
  receivables: ReceivableInput[]
  /** Obligations already resolved to a due date inside the window. */
  obligationsDue: number
  obligationsBasis: string
  /**
   * Recurring bills with no due date recorded.
   *
   * `getCashDebtSummary` deliberately keeps these out of its dated windows
   * because it cannot know WHEN they land. For affordability they must still be
   * subtracted: a monthly Rent or Electric bill will be paid whether or not
   * anyone typed a date, and ignoring them overstates spendable cash.
   */
  unscheduledObligations?: number
  unscheduledObligationNames?: string[]
  monthlyDebtService: number
  payrollDue: number
  payrollBasis: string
  /** Typical monthly money in, from complete months of history. */
  expectedInflow: number
  inflowBasis: string
  /** Typical monthly money out, from complete months of history. */
  expectedOutflow: number
  outflowBasis: string
}): AvailableOperatingCash {
  const excludedReceivables: AvailableOperatingCash['excludedReceivables'] = []
  let expectedReceivables = 0

  for (const r of input.receivables) {
    if (r.status === 'Paid') continue
    const outstanding = r.amount - r.amountPaid
    if (outstanding <= 0) continue
    const reason = placeholderReceivableReason(r)
    if (reason) {
      excludedReceivables.push({
        customer: r.customerName || '(blank)',
        amount: outstanding,
        reason,
      })
      continue
    }
    expectedReceivables += outstanding
  }

  const deductions: CashDeduction[] = [
    {
      label: 'Recurring obligations due',
      amount: input.obligationsDue,
      basis: input.obligationsBasis,
    },
    {
      label: 'Recurring bills with no date set',
      amount: input.unscheduledObligations ?? 0,
      basis:
        (input.unscheduledObligationNames ?? []).length > 0
          ? `${(input.unscheduledObligationNames ?? []).join(', ')} — recurring, but no due date on file. Counted because they still get paid.`
          : 'Recurring obligations with no due date recorded',
    },
    {
      label: 'Payroll',
      amount: input.payrollDue,
      basis: input.payrollBasis,
    },
    {
      label: 'Loan payments',
      amount: input.monthlyDebtService,
      basis: 'Sum of monthly payments on active loans',
    },
  ].filter((d) => d.amount > 0)

  const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0)

  // Project month-end cash the way cash actually moves: start with what's in the
  // bank, add what you're owed and what you typically collect, subtract what you
  // typically pay. The previous version omitted `expectedInflow` altogether, so a
  // profitable business looked like it was bleeding out every month.
  const projectedCash =
    input.cashOnHand +
    expectedReceivables +
    input.expectedInflow -
    input.expectedOutflow

  return {
    cashOnHand: input.cashOnHand,
    minCashReserve: input.minCashReserve,
    expectedReceivables,
    expectedInflow: input.expectedInflow,
    inflowBasis: input.inflowBasis,
    expectedOutflow: input.expectedOutflow,
    outflowBasis: input.outflowBasis,
    deductions,
    totalDeductions,
    projectedCash,
    availableOperatingCash: projectedCash - input.minCashReserve,
    excludedReceivables,
  }
}

/* ------------------------------------------------------------------ */
/* Step 6 — Seasonality                                                */
/* ------------------------------------------------------------------ */

export type MonthlyRevenueRow = { monthKey: string; revenue: number }

export type SeasonalityMonth = {
  /** 1-12. */
  month: number
  label: string
  /** 1.0 = an average month. 1.2 = 20% above average. */
  index: number
  /** Weighted mean revenue behind the index. */
  weightedRevenue: number
  /** How many observed years contributed. */
  years: number
}

export type Seasonality = {
  months: SeasonalityMonth[]
  /** Index for the month the recommendation is being made for. */
  nextMonth: SeasonalityMonth | null
  strongMonths: string[]
  weakMonths: string[]
}

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * Seasonal index per calendar month, weighting recent years more heavily.
 *
 * A plain average would treat a month from two years ago as equally
 * representative of today's business, which for a growing store understates the
 * present. Weight doubles for each step toward the newest year.
 */
export function computeSeasonality(
  revenue: MonthlyRevenueRow[],
  targetMonthKey: string,
): Seasonality {
  const years = [...new Set(revenue.map((r) => Number(r.monthKey.slice(0, 4))))].sort()
  const newest = years[years.length - 1] ?? 0
  const weightFor = (year: number) => 2 ** -(newest - year)

  // Overall weighted mean monthly revenue, the denominator of every index.
  let totalWeighted = 0
  let totalWeight = 0
  for (const r of revenue) {
    const w = weightFor(Number(r.monthKey.slice(0, 4)))
    totalWeighted += r.revenue * w
    totalWeight += w
  }
  const meanMonthly = totalWeight > 0 ? totalWeighted / totalWeight : 0

  const months: SeasonalityMonth[] = []
  for (let m = 1; m <= 12; m += 1) {
    const rows = revenue.filter((r) => Number(r.monthKey.slice(5, 7)) === m)
    if (rows.length === 0) {
      months.push({
        month: m,
        label: MONTH_LABELS[m - 1],
        index: 1,
        weightedRevenue: 0,
        years: 0,
      })
      continue
    }
    let sum = 0
    let weight = 0
    for (const r of rows) {
      const w = weightFor(Number(r.monthKey.slice(0, 4)))
      sum += r.revenue * w
      weight += w
    }
    const weightedRevenue = sum / weight
    months.push({
      month: m,
      label: MONTH_LABELS[m - 1],
      index: meanMonthly > 0 ? weightedRevenue / meanMonthly : 1,
      weightedRevenue,
      years: rows.length,
    })
  }

  const observed = months.filter((m) => m.years > 0)
  const targetMonth = Number(targetMonthKey.slice(5, 7))

  return {
    months,
    nextMonth: months.find((m) => m.month === targetMonth) ?? null,
    strongMonths: [...observed]
      .sort((a, b) => b.index - a.index)
      .slice(0, 3)
      .map((m) => m.label),
    weakMonths: [...observed]
      .sort((a, b) => a.index - b.index)
      .slice(0, 3)
      .map((m) => m.label),
  }
}

/* ------------------------------------------------------------------ */
/* Step 3 — Recommended budget                                         */
/* ------------------------------------------------------------------ */

export type BudgetAdjustment = {
  label: string
  /** Multiplier applied to the running figure. 1.0 = no change. */
  factor: number
  reason: string
}

export type RecommendedBudget = {
  /** Revenue percentage starting point, before any judgement. */
  baseline: number
  baselinePct: number
  trailingMonthlyRevenue: number
  adjustments: BudgetAdjustment[]
  /** After adjustments, before the affordability and ceiling clamps. */
  adjusted: number
  /** Ceiling from settings, as a dollar figure. */
  ceiling: number
  /** Final recommendation. */
  recommended: number
  /** Which limit, if any, decided the final number. */
  boundBy: 'affordability' | 'ceiling' | 'none'
}

export function computeRecommendedBudget(input: {
  trailingMonthlyRevenue: number
  baselinePct: number
  ceilingPct: number
  /** Most this month's cash can support in TOTAL marketing. */
  maxSafeTotal: number
  seasonalIndex: number
  revenueTrendPct: number
  /** Projected cash as a multiple of the reserve target. */
  reserveCoverage: number
  payrollPct: number
  targetPayrollPct: number
  creditUtilization: number
}): RecommendedBudget {
  const baseline = (input.trailingMonthlyRevenue * input.baselinePct) / 100
  const adjustments: BudgetAdjustment[] = []

  // Cash position. This is the dominant signal: advertising is discretionary,
  // and a thin reserve is a reason to hold back regardless of revenue.
  if (input.reserveCoverage < 1) {
    adjustments.push({
      label: 'Cash below reserve',
      factor: 0.25,
      reason: `Projected cash covers only ${(input.reserveCoverage * 100).toFixed(0)}% of the reserve target`,
    })
  } else if (input.reserveCoverage < 1.25) {
    adjustments.push({
      label: 'Cash near reserve',
      factor: 0.6,
      reason: `Projected cash sits just ${((input.reserveCoverage - 1) * 100).toFixed(0)}% above the reserve target`,
    })
  } else if (input.reserveCoverage > 2) {
    adjustments.push({
      label: 'Strong cash position',
      factor: 1.15,
      reason: `Projected cash is ${input.reserveCoverage.toFixed(1)}x the reserve target`,
    })
  }

  // Revenue trend.
  if (input.revenueTrendPct >= 5) {
    adjustments.push({
      label: 'Revenue growing',
      factor: 1.1,
      reason: `Revenue up ${input.revenueTrendPct.toFixed(1)}% versus the prior period`,
    })
  } else if (input.revenueTrendPct <= -5) {
    adjustments.push({
      label: 'Revenue declining',
      factor: 0.85,
      reason: `Revenue down ${Math.abs(input.revenueTrendPct).toFixed(1)}% versus the prior period`,
    })
  }

  // Seasonality: spend ahead of a strong month, ease off before a weak one.
  if (input.seasonalIndex >= 1.1) {
    adjustments.push({
      label: 'Strong season ahead',
      factor: 1.2,
      reason: `Next month historically runs ${((input.seasonalIndex - 1) * 100).toFixed(0)}% above an average month`,
    })
  } else if (input.seasonalIndex <= 0.9) {
    adjustments.push({
      label: 'Weak season ahead',
      factor: 0.85,
      reason: `Next month historically runs ${((1 - input.seasonalIndex) * 100).toFixed(0)}% below an average month`,
    })
  }

  // Payroll load.
  if (input.payrollPct > input.targetPayrollPct + 5) {
    adjustments.push({
      label: 'Payroll above target',
      factor: 0.8,
      reason: `Payroll is ${input.payrollPct.toFixed(1)}% of revenue against a ${input.targetPayrollPct}% target`,
    })
  }

  // Borrowing. Cash that is really drawn credit should not fund advertising.
  if (input.creditUtilization > 0.5) {
    adjustments.push({
      label: 'Credit line heavily drawn',
      factor: 0.75,
      reason: `${(input.creditUtilization * 100).toFixed(0)}% of the available credit line is already drawn`,
    })
  }

  const adjusted = adjustments.reduce((v, a) => v * a.factor, baseline)
  const ceiling = (input.trailingMonthlyRevenue * input.ceilingPct) / 100

  // Order matters: affordability wins over the percentage ceiling, because the
  // ceiling is a policy preference while affordability is a cash fact.
  let recommended = Math.min(adjusted, ceiling)
  let boundBy: RecommendedBudget['boundBy'] = 'none'
  if (recommended > input.maxSafeTotal) {
    recommended = input.maxSafeTotal
    boundBy = 'affordability'
  } else if (adjusted > ceiling) {
    boundBy = 'ceiling'
  }

  return {
    baseline,
    baselinePct: input.baselinePct,
    trailingMonthlyRevenue: input.trailingMonthlyRevenue,
    adjustments,
    adjusted,
    ceiling,
    recommended: Math.max(0, roundCents(recommended)),
    boundBy,
  }
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100
}

/* ------------------------------------------------------------------ */
/* Step 4 — Affordability score                                        */
/* ------------------------------------------------------------------ */

export type CapacityBand =
  | 'Excellent'
  | 'Healthy'
  | 'Watch'
  | 'Limited'
  | 'Do Not Increase'

export type AffordabilityScore = {
  score: number
  band: CapacityBand
  /** Each scored pillar, so the number is never a black box. */
  components: { label: string; points: number; max: number; detail: string }[]
  headline: string
}

export function scoreAffordability(input: {
  reserveCoverage: number
  daysCashOnHand: number
  daysCashTarget: number
  netMonthlyCashFlow: number
  trailingMonthlyRevenue: number
  payrollPct: number
  targetPayrollPct: number
  creditUtilization: number
  additionalSafe: number
}): AffordabilityScore {
  const components: AffordabilityScore['components'] = []

  // Reserve coverage — 40 points. The single most important factor.
  const reservePoints = Math.max(0, Math.min(40, Math.round((input.reserveCoverage - 0.5) * 40)))
  components.push({
    label: 'Cash reserve coverage',
    points: reservePoints,
    max: 40,
    detail:
      input.reserveCoverage >= 1
        ? `Projected cash is ${input.reserveCoverage.toFixed(2)}x the reserve target`
        : `Projected cash is below the reserve target (${(input.reserveCoverage * 100).toFixed(0)}%)`,
  })

  // Days cash on hand — 25 points.
  const daysRatio = input.daysCashTarget > 0 ? input.daysCashOnHand / input.daysCashTarget : 0
  const daysPoints = Math.max(0, Math.min(25, Math.round(daysRatio * 25)))
  components.push({
    label: 'Days cash on hand',
    points: daysPoints,
    max: 25,
    detail: `${input.daysCashOnHand.toFixed(0)} days against a ${input.daysCashTarget}-day target`,
  })

  // Net monthly cash generation — 20 points.
  const netRatio =
    input.trailingMonthlyRevenue > 0
      ? input.netMonthlyCashFlow / input.trailingMonthlyRevenue
      : 0
  const netPoints = Math.max(0, Math.min(20, Math.round((netRatio + 0.05) * 200)))
  components.push({
    label: 'Monthly cash generation',
    points: netPoints,
    max: 20,
    detail:
      input.netMonthlyCashFlow >= 0
        ? `Generating ${formatMoney(input.netMonthlyCashFlow)} a month on average`
        : `Burning ${formatMoney(Math.abs(input.netMonthlyCashFlow))} a month on average`,
  })

  // Payroll discipline — 10 points.
  const payrollPoints =
    input.payrollPct <= input.targetPayrollPct
      ? 10
      : Math.max(0, 10 - Math.round(input.payrollPct - input.targetPayrollPct))
  components.push({
    label: 'Payroll load',
    points: payrollPoints,
    max: 10,
    detail: `Payroll at ${input.payrollPct.toFixed(1)}% of revenue against a ${input.targetPayrollPct}% target`,
  })

  // Credit headroom — 5 points.
  const creditPoints = Math.max(0, Math.min(5, Math.round((1 - input.creditUtilization) * 5)))
  components.push({
    label: 'Credit headroom',
    points: creditPoints,
    max: 5,
    detail: `${(input.creditUtilization * 100).toFixed(0)}% of the credit line is drawn`,
  })

  const score = components.reduce((s, c) => s + c.points, 0)

  // A breached reserve or nothing left over forces the bottom band no matter
  // how the other pillars scored. Marketing is the most deferrable cost there is.
  let band: CapacityBand
  if (input.additionalSafe <= 0 || input.reserveCoverage < 1) band = 'Do Not Increase'
  else if (score >= 80) band = 'Excellent'
  else if (score >= 60) band = 'Healthy'
  else if (score >= 40) band = 'Watch'
  else band = 'Limited'

  const headline =
    band === 'Do Not Increase'
      ? input.reserveCoverage < 1
        ? 'Do not increase marketing. Known obligations would pull cash below the reserve target.'
        : 'Do not increase marketing. There is no headroom above the reserve target this month.'
      : `Cash flow supports increasing marketing by roughly ${formatMoney(input.additionalSafe)} this month while holding the reserve.`

  return { score, band, components, headline }
}

function formatMoney(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/* ------------------------------------------------------------------ */
/* Step 5 — Scenarios                                                  */
/* ------------------------------------------------------------------ */

export type ScenarioRisk = 'Safe' | 'Caution' | 'High Risk' | 'Unsafe'

export type Scenario = {
  increase: number
  endingCash: number
  /** Cash above (positive) or below (negative) the reserve target. */
  reserveRemaining: number
  daysCashOnHand: number
  risk: ScenarioRisk
  note: string
}

export function buildScenarios(input: {
  projectedCash: number
  minCashReserve: number
  avgDailyOutflow: number
  increments: number[]
}): Scenario[] {
  return input.increments.map((increase) => {
    const endingCash = input.projectedCash - increase
    const reserveRemaining = endingCash - input.minCashReserve
    const daysCashOnHand =
      input.avgDailyOutflow > 0 ? Math.max(0, endingCash) / input.avgDailyOutflow : 0

    let risk: ScenarioRisk
    let note: string
    if (endingCash < 0) {
      risk = 'Unsafe'
      note = 'Would overdraw the account'
    } else if (reserveRemaining < 0) {
      risk = 'Unsafe'
      note = `Breaches the reserve by ${formatMoney(Math.abs(reserveRemaining))}`
    } else if (reserveRemaining < input.minCashReserve * 0.1) {
      risk = 'High Risk'
      note = 'Leaves almost nothing above the reserve'
    } else if (reserveRemaining < input.minCashReserve * 0.25) {
      risk = 'Caution'
      note = 'Reserve holds, but with a thin margin'
    } else {
      risk = 'Safe'
      note = 'Reserve target is maintained'
    }

    return {
      increase,
      endingCash: roundCents(endingCash),
      reserveRemaining: roundCents(reserveRemaining),
      daysCashOnHand,
      risk,
      note,
    }
  })
}

/* ------------------------------------------------------------------ */
/* Step 9 — Data quality / confidence                                  */
/* ------------------------------------------------------------------ */

export type ConfidencePillar = {
  label: string
  pct: number
  /** Why it is not 100%, or a confirmation that it is. */
  detail: string
}

export type Confidence = {
  revenue: ConfidencePillar
  expense: ConfidencePillar
  cashFlow: ConfidencePillar
  recommendation: ConfidencePillar
  /** Plain-language list of what is holding confidence back. */
  gaps: string[]
}

export function computeConfidence(input: {
  revenueMonths: number
  revenueMonthsFromApi: number
  categorizedSpendPct: number
  incompleteMonths: string[]
  gapMonths: string[]
  totalMonthsCovered: number
  balancesUpdatedDaysAgo: number | null
  hasRealReceivables: boolean
  excludedReceivableCount: number
}): Confidence {
  const gaps: string[] = []

  // Revenue: driven by how much of the series came from the Square API rather
  // than manual entry, and by having at least a year for seasonality.
  const apiShare =
    input.revenueMonths > 0 ? input.revenueMonthsFromApi / input.revenueMonths : 0
  const seasonalityShare = Math.min(1, input.revenueMonths / 24)
  const revenuePct = Math.round((apiShare * 0.7 + seasonalityShare * 0.3) * 100)
  if (apiShare < 1) {
    gaps.push(
      `${input.revenueMonths - input.revenueMonthsFromApi} of ${input.revenueMonths} revenue months are calculated or manually entered rather than pulled from Square.`,
    )
  }

  // Expense: categorization coverage by DOLLARS, plus months of missing banking.
  const monthPenalty =
    input.totalMonthsCovered > 0
      ? (input.incompleteMonths.length + input.gapMonths.length) / input.totalMonthsCovered
      : 0
  const expensePct = Math.max(
    0,
    Math.round(input.categorizedSpendPct * 100 * (1 - monthPenalty)),
  )
  if (input.categorizedSpendPct < 0.9) {
    gaps.push(
      `Only ${(input.categorizedSpendPct * 100).toFixed(0)}% of spend dollars are categorized, so marketing spend may be understated.`,
    )
  }
  if (input.gapMonths.length > 0) {
    gaps.push(
      `No transactions at all imported for ${input.gapMonths.join(', ')} — costs for those months are missing entirely.`,
    )
  }
  if (input.incompleteMonths.length > 0) {
    gaps.push(
      `${input.incompleteMonths.join(', ')} have spending but no deposits, so only part of the banking was imported.`,
    )
  }

  // Cash flow: how fresh the balances are, and whether receivables are real.
  let cashPct = 100
  if (input.balancesUpdatedDaysAgo == null) {
    cashPct = 40
    gaps.push('No account balance has ever been updated, so cash on hand is unknown.')
  } else if (input.balancesUpdatedDaysAgo > 30) {
    cashPct = 55
    gaps.push(
      `Account balances were last updated ${input.balancesUpdatedDaysAgo} days ago and may be stale.`,
    )
  } else if (input.balancesUpdatedDaysAgo > 7) {
    cashPct = 80
    gaps.push(`Account balances were last updated ${input.balancesUpdatedDaysAgo} days ago.`)
  }
  if (input.excludedReceivableCount > 0) {
    cashPct = Math.min(cashPct, 85)
    gaps.push(
      `${input.excludedReceivableCount} receivable ${input.excludedReceivableCount === 1 ? 'row is' : 'rows are'} placeholder data and were left out of the cash projection.`,
    )
  }

  // The recommendation can never be more trustworthy than its weakest input.
  const recommendationPct = Math.round(
    Math.min(revenuePct, cashPct) * 0.6 + expensePct * 0.4,
  )

  return {
    revenue: {
      label: 'Revenue confidence',
      pct: revenuePct,
      detail:
        apiShare === 1
          ? `All ${input.revenueMonths} months pulled directly from Square`
          : `${input.revenueMonthsFromApi} of ${input.revenueMonths} months pulled directly from Square`,
    },
    expense: {
      label: 'Expense confidence',
      pct: expensePct,
      detail: `${(input.categorizedSpendPct * 100).toFixed(0)}% of spend dollars categorized across ${input.totalMonthsCovered} months`,
    },
    cashFlow: {
      label: 'Cash flow confidence',
      pct: cashPct,
      detail:
        input.balancesUpdatedDaysAgo == null
          ? 'No balance updates recorded'
          : `Balances updated ${input.balancesUpdatedDaysAgo} day${input.balancesUpdatedDaysAgo === 1 ? '' : 's'} ago`,
    },
    recommendation: {
      label: 'Recommendation confidence',
      pct: recommendationPct,
      detail: 'Weighted from the revenue, cash and expense confidence above',
    },
    gaps,
  }
}

/* ------------------------------------------------------------------ */
/* Step 10 — ROI hook (forward compatible)                             */
/* ------------------------------------------------------------------ */

/**
 * Per-channel return, for when ad-platform data is connected.
 *
 * Nothing populates this yet and it is deliberately left empty rather than
 * filled with sample numbers. Once real spend/revenue pairs exist per channel,
 * `optimizeByRoi` becomes the allocation step and the revenue percentage drops
 * back to being a sanity bound rather than the driver.
 */
export type ChannelRoi = {
  channel: string
  spend: number
  attributedRevenue: number
  /** Revenue per dollar spent. */
  roas: number
  customersAcquired: number | null
  customerAcquisitionCost: number | null
  lifetimeValue: number | null
}

/**
 * Split a budget across channels by expected return, best first.
 *
 * Exported now so the engine's shape does not have to change when ROI data
 * arrives. Returns an even split when no ROI is known, which is the honest
 * behaviour for zero information.
 */
export function optimizeByRoi(
  budget: number,
  channels: ChannelRoi[],
): { channel: string; allocation: number; rationale: string }[] {
  if (channels.length === 0) return []
  const scored = channels.filter((c) => c.roas > 0)
  if (scored.length === 0) {
    const even = budget / channels.length
    return channels.map((c) => ({
      channel: c.channel,
      allocation: roundCents(even),
      rationale: 'No return data yet — split evenly',
    }))
  }
  const totalRoas = scored.reduce((s, c) => s + c.roas, 0)
  return scored
    .sort((a, b) => b.roas - a.roas)
    .map((c) => ({
      channel: c.channel,
      allocation: roundCents((budget * c.roas) / totalRoas),
      rationale: `Returns $${c.roas.toFixed(2)} per $1 spent`,
    }))
}

/* ------------------------------------------------------------------ */
/* Step 7 — Narrative recommendation                                   */
/* ------------------------------------------------------------------ */

export type MarketingRecommendation = {
  action: 'increase' | 'maintain' | 'reduce'
  amount: number
  summary: string
  reasons: string[]
  /** Safety rules that actively bound the answer. */
  blockers: string[]
}

export function buildRecommendation(input: {
  band: CapacityBand
  currentMonthlyMarketing: number
  recommended: number
  additionalSafe: number
  reserveCoverage: number
  revenueTrendPct: number
  seasonalIndex: number
  seasonalLabel: string | null
  payrollPct: number
  targetPayrollPct: number
  obligationsDue: number
  unscheduledObligations?: number
  boundBy: RecommendedBudget['boundBy']
}): MarketingRecommendation {
  const reasons: string[] = []
  const blockers: string[] = []

  if (input.reserveCoverage < 0) {
    // A negative coverage is a shortfall, not a percentage of the target.
    // "cash at -11% of the reserve target" is not a sentence anyone can act on.
    blockers.push(
      'This month\u2019s known bills come to more than the cash on hand, before any marketing.',
    )
  } else if (input.reserveCoverage < 1) {
    blockers.push(
      `Known obligations would leave cash at ${(input.reserveCoverage * 100).toFixed(0)}% of the reserve target.`,
    )
  }
  if (input.additionalSafe <= 0) {
    blockers.push('There is no cash headroom above the reserve target this month.')
  }
  if (input.boundBy === 'affordability') {
    blockers.push(
      'The revenue-based figure was reduced to what this month\u2019s cash can actually cover.',
    )
  }

  if (input.revenueTrendPct >= 5) {
    reasons.push(`Revenue is trending up ${input.revenueTrendPct.toFixed(1)}%.`)
  } else if (input.revenueTrendPct <= -5) {
    reasons.push(`Revenue is trending down ${Math.abs(input.revenueTrendPct).toFixed(1)}%.`)
  } else {
    reasons.push('Revenue is broadly flat.')
  }

  if (input.seasonalLabel && input.seasonalIndex >= 1.1) {
    reasons.push(
      `${input.seasonalLabel} is historically ${((input.seasonalIndex - 1) * 100).toFixed(0)}% above an average month, so spending ahead of it pays back sooner.`,
    )
  } else if (input.seasonalLabel && input.seasonalIndex <= 0.9) {
    reasons.push(
      `${input.seasonalLabel} is historically ${((1 - input.seasonalIndex) * 100).toFixed(0)}% below average, so this is a poor month to add spend.`,
    )
  }

  reasons.push(
    input.payrollPct <= input.targetPayrollPct
      ? `Payroll is within target at ${input.payrollPct.toFixed(1)}% of revenue.`
      : `Payroll is above target at ${input.payrollPct.toFixed(1)}% of revenue.`,
  )

  // Report the recurring bills on file, dated or not, as context. They are part
  // of the typical monthly costs already reflected in the cash projection — no
  // longer a separate subtraction, so the wording says "on file", not "counted".
  const totalObligations = input.obligationsDue + (input.unscheduledObligations ?? 0)
  if (totalObligations > 0) {
    const undated = input.unscheduledObligations ?? 0
    reasons.push(
      undated > 0
        ? `${formatMoney(totalObligations)} of recurring bills are on file, including ${formatMoney(undated)} with no due date recorded.`
        : `${formatMoney(totalObligations)} of recurring bills are on file.`,
    )
  }

  const delta = input.recommended - input.currentMonthlyMarketing
  let action: MarketingRecommendation['action']
  let summary: string

  if (input.reserveCoverage < 0) {
    // Bills already exceed cash on hand. Any non-zero "recommended" figure here
    // comes from marketing that is ALREADY committed, so presenting it as a
    // budget the owner may spend would be actively misleading.
    action = 'reduce'
    summary =
      `Cut marketing spend as far as existing commitments allow. ${blockers[0] ?? ''}`.trim()
  } else if (input.band === 'Do Not Increase' || input.additionalSafe <= 0) {
    action = delta < -1 ? 'reduce' : 'maintain'
    summary =
      delta < -1
        ? `Reduce marketing to ${formatMoney(input.recommended)} a month. ${blockers[0] ?? ''}`.trim()
        : `Maintain current marketing at ${formatMoney(input.currentMonthlyMarketing)} a month. ${blockers[0] ?? ''}`.trim()
  } else if (delta > 1) {
    action = 'increase'
    summary = `Increase marketing by ${formatMoney(delta)} this month, to ${formatMoney(input.recommended)}.`
  } else if (delta < -1) {
    action = 'reduce'
    summary = `Reduce marketing by ${formatMoney(Math.abs(delta))} this month, to ${formatMoney(input.recommended)}.`
  } else {
    action = 'maintain'
    summary = `Maintain current marketing at ${formatMoney(input.currentMonthlyMarketing)} a month.`
  }

  return { action, amount: roundCents(delta), summary, reasons, blockers }
}

/* ------------------------------------------------------------------ */
/* Live assembly                                                       */
/* ------------------------------------------------------------------ */

/**
 * The cash facts this engine needs, passed in rather than read here.
 *
 * `getCashDebtSummary` in `lib/queries.ts` already derives all of this from
 * live records. Re-deriving it here would risk the two drifting apart, and
 * services in this codebase never import `queries.ts` (that direction is
 * reserved for the other way round, to keep the module graph acyclic).
 */
export type CashPositionInput = {
  cashOnHand: number
  minCashReserve: number
  /** Recurring obligations with a resolved due date inside 30 days. */
  obligations30: number
  /**
   * Recurring bills with NO due date on file.
   *
   * `getCashDebtSummary` reports these separately and keeps them out of
   * `obligations30`, because it cannot say when they land. They must still be
   * subtracted here — every obligation row in this business currently has a
   * null due date, so trusting `obligations30` alone reported $0 of bills while
   * $6,211/month of rent, utilities and marketing went unaccounted for.
   */
  unscheduledObligations: number
  unscheduledObligationNames: string[]
  monthlyDebtService: number
  creditDrawn: number
  creditLimitTotal: number
  receivables: ReceivableInput[]
  /** Most recent `last_updated` across cash accounts, ISO date or null. */
  balancesUpdatedAt: string | null
  targetPayrollPct: number
  baselinePct: number
  ceilingPct: number
  daysCashTarget: number
}

export type MarketingAffordability = {
  spend: CurrentMarketingSpend
  cash: AvailableOperatingCash
  budget: RecommendedBudget
  score: AffordabilityScore
  scenarios: Scenario[]
  seasonality: Seasonality
  confidence: Confidence
  recommendation: MarketingRecommendation
  /** Total marketing this month's cash can support, existing spend included. */
  maxSafeTotal: number
  /** Extra marketing available on top of what is already committed. */
  additionalSafe: number
  /** Committed recurring marketing found in cash_obligations. */
  committedMonthly: number
  /** Set when the committed obligation and actual spend disagree materially. */
  commitmentMismatch: {
    committed: number
    actual: number
    note: string
  } | null
  metrics: {
    trailingMonthlyRevenue: number
    trailingRevenue12: number
    revenueTrendPct: number
    netMonthlyCashFlow: number
    avgDailyOutflow: number
    daysCashOnHand: number
    daysCashTarget: number
    payrollPct: number
    payrollMonthly: number
    reserveCoverage: number
    creditUtilization: number
    targetMonthKey: string
    targetMonthLabel: string
  }
  /**
   * How current the bank feed is. Every cash figure is only as fresh as the last
   * imported transaction, so when this lags the whole page must say so rather
   * than presenting month-old data as today's position.
   */
  dataFreshness: {
    /** ISO date of the most recent bank transaction on file, or null. */
    latestTransactionDate: string | null
    /** Whole days between that transaction and today. */
    daysBehind: number | null
    /** True once the feed is far enough behind to distrust the numbers. */
    isStale: boolean
  }
  /** Empty until ad-platform data exists; see `optimizeByRoi`. */
  roi: ChannelRoi[]
  /**
   * Advertising charges found in the ledger that are NOT categorized Marketing,
   * so every figure above excludes them. Usually the reason reported spend looks
   * far lower than what the owner knows they spend.
   */
  uncategorizedMarketing: UncategorizedMarketing
  /**
   * Why the trailing average can disagree with what the owner knows they pay:
   * channels that stopped appearing in the feed, and spend the bank export
   * cannot attribute to any payee at all.
   */
  reconciliation: SpendReconciliation
  hasData: boolean
}

/** Scenario increments offered by the slider, smallest first. */
export const SCENARIO_INCREMENTS = [250, 500, 1000, 2000, 3000]

async function fetchTransactions(): Promise<CashFlowInputRow[]> {
  const supabase = await createClient()
  const rows = await fetchAllPages(
    (from, to) =>
      supabase
        .from('financial_transactions')
        .select(
          'id, transaction_date, description, normalized_description, amount, transaction_type, review_status, vendor_id, expense_category, account_name',
        )
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    'financial_transactions (marketing affordability)',
  )
  return rows.map((t: Record<string, unknown>) => ({
    id: String(t.id),
    transactionDate: String(t.transaction_date ?? ''),
    description: String(t.description ?? ''),
    normalizedDescription: String(t.normalized_description ?? ''),
    amount: Number(t.amount ?? 0),
    transactionType: (t.transaction_type ?? 'expense') as CashFlowInputRow['transactionType'],
    reviewStatus: (t.review_status ?? 'unreviewed') as CashFlowInputRow['reviewStatus'],
    vendorId: t.vendor_id ? String(t.vendor_id) : null,
    expenseCategory: String(t.expense_category ?? ''),
    accountName: String(t.account_name ?? ''),
  }))
}

/**
 * Monthly revenue from `sales_monthly`, which is fed by the Square API.
 *
 * Ordered by year first. Sorting on `month_order` alone interleaves months from
 * different years — a bug already fixed once in `getSalesMonthly`.
 */
async function fetchMonthlyRevenue(): Promise<{
  rows: MonthlyRevenueRow[]
  fromApi: number
}> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('sales_monthly')
    .select(
      'year, month_order, retail, wholesale, calculated_retail, calculated_wholesale, source',
    )
    .order('year', { ascending: true, nullsFirst: true })
    .order('month_order', { ascending: true })

  if (error) throw new Error(`sales_monthly: ${error.message}`)

  const rows: MonthlyRevenueRow[] = []
  let fromApi = 0
  for (const r of data ?? []) {
    const year = Number(r.year)
    const monthOrder = Number(r.month_order)
    if (!year || !monthOrder) continue
    const retail = Number(r.retail ?? r.calculated_retail ?? 0)
    const wholesale = Number(r.wholesale ?? r.calculated_wholesale ?? 0)
    rows.push({
      monthKey: `${year}-${String(monthOrder).padStart(2, '0')}`,
      revenue: retail + wholesale,
    })
    if (String(r.source) === 'square_api') fromApi += 1
  }
  return { rows, fromApi }
}

/** Vendors the owner has classified as Marketing. */
async function fetchMarketingVendorIds(): Promise<Set<string>> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('vendors')
    .select('id, category')
    .eq('category', MARKETING_CATEGORY)
  return new Set((data ?? []).map((v) => String(v.id)))
}

/**
 * Payee-less rows the owner has already identified on the Check Resolution
 * screen.
 *
 * Read-only, and deliberately does NOT touch `financial_transactions` — that
 * table stays verbatim so a resolution can never be mistaken for source data
 * (see the contract at the top of `lib/check-resolution-service.ts`).
 */
async function fetchCheckResolutions(): Promise<Map<string, ResolvedPayee>> {
  const supabase = await createClient()
  const out = new Map<string, ResolvedPayee>()
  for (let page = 0; ; page += 1) {
    const from = page * 1000
    const { data, error } = await supabase
      .from('check_resolutions')
      .select('financial_transaction_id, resolved_payee, resolved_category, review_status')
      .range(from, from + 999)
    if (error) break
    const rows = data ?? []
    for (const r of rows) {
      // Only approved resolutions count. A pending guess must not silently
      // become a number the owner is asked to act on.
      if (r.review_status && r.review_status !== 'approved') continue
      const id = r.financial_transaction_id == null ? '' : String(r.financial_transaction_id)
      if (!id) continue
      out.set(id, {
        payee: String(r.resolved_payee ?? ''),
        category: String(r.resolved_category ?? ''),
      })
    }
    if (rows.length < 1000) break
  }
  return out
}

/** The recurring marketing line the owner has already committed to, if any. */
async function fetchCommittedMarketing(): Promise<number> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('cash_obligations')
    .select('obligation_name, category, amount, frequency, status, active')
  let total = 0
  for (const o of data ?? []) {
    if (o.status === 'Paid' || o.active === false) continue
    const name = String(o.obligation_name ?? '').toLowerCase()
    const category = String(o.category ?? '').toLowerCase()
    if (!/market|advertis|promo/.test(name) && !/market|advertis|promo/.test(category)) {
      continue
    }
    const amount = Number(o.amount ?? 0)
    // Normalise to a monthly figure so a weekly or annual line is comparable.
    const freq = String(o.frequency ?? 'Monthly').toLowerCase()
    if (freq.startsWith('week')) total += amount * (52 / 12)
    else if (freq.startsWith('bi-week') || freq.startsWith('biweek')) total += amount * (26 / 12)
    else if (freq.startsWith('quarter')) total += amount / 3
    else if (freq.startsWith('annual') || freq.startsWith('year')) total += amount / 12
    else total += amount
  }
  return roundCents(total)
}

function daysBetween(from: string | null, today: Date): number | null {
  if (!from) return null
  const d = new Date(from.slice(0, 10) + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return null
  return Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86_400_000))
}

/**
 * Assemble the full affordability picture from live records.
 *
 * Returns `hasData: false` (rather than zeros that look like a real answer)
 * when there are no transactions or no revenue history to reason from.
 */
export async function getMarketingAffordability(
  cash: CashPositionInput,
  now: Date = new Date(),
): Promise<MarketingAffordability> {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const [txns, revenue, marketingVendorIds, committedMonthly, checkResolutions] = await Promise.all(
    [
      fetchTransactions(),
      fetchMonthlyRevenue(),
      fetchMarketingVendorIds(),
      fetchCommittedMarketing(),
      fetchCheckResolutions(),
    ],
  )

  const spend = summarizeCurrentMarketingSpend(txns, marketingVendorIds, today)
  const uncategorizedMarketing = findUncategorizedMarketing(txns, marketingVendorIds)
  const reconciliation = reconcileKnownSpend(
    txns,
    marketingVendorIds,
    today,
    2,
    {},
    checkResolutions,
  )
  const monthly = deriveMonthlyCashFlow(txns, { months: 24 })

  // ---- Revenue ----
  const revRows = revenue.rows
  const trailing12 = revRows.slice(-12)
  const trailingRevenue12 = trailing12.reduce((s, r) => s + r.revenue, 0)
  const trailingMonthlyRevenue =
    trailing12.length > 0 ? trailingRevenue12 / trailing12.length : 0

  const last3 = revRows.slice(-3).reduce((s, r) => s + r.revenue, 0)
  const prior3 = revRows.slice(-6, -3).reduce((s, r) => s + r.revenue, 0)
  const revenueTrendPct = prior3 > 0 ? ((last3 - prior3) / prior3) * 100 : 0

  // ---- Payroll ----
  // Averaged over the most recent months that actually contain payroll rows.
  // Several months have no payroll at all because only a card statement was
  // imported for them; including those zeros would halve the estimate.
  const payrollByMonth = new Map<string, number>()
  for (const t of txns) {
    if (t.reviewStatus === 'excluded') continue
    if (!SPEND_TYPES.includes(t.transactionType as TransactionType)) continue
    const cat = canonicalCategory(t.expenseCategory, {})
    if (!/^payroll/i.test(cat)) continue
    const k = monthKeyOf(t.transactionDate)
    if (!k) continue
    payrollByMonth.set(k, (payrollByMonth.get(k) ?? 0) + Math.abs(t.amount))
  }
  const payrollMonths = [...payrollByMonth]
    .filter(([, v]) => v > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-3)
  const payrollMonthly =
    payrollMonths.length > 0
      ? payrollMonths.reduce((s, [, v]) => s + v, 0) / payrollMonths.length
      : 0
  const payrollBasis =
    payrollMonths.length > 0
      ? `Average of the last ${payrollMonths.length} month${payrollMonths.length === 1 ? '' : 's'} with payroll activity (${payrollMonths.map(([k]) => monthLabel(k)).join(', ')})`
      : 'No payroll transactions found'

  // ---- Derived cash metrics ----
  // Computed before the cash position because the projection now depends on
  // them: a month's expected money-in and money-out are the whole point.
  const completeMonths = monthly.series.filter((m) => m.complete)
  const avgMonthlyInflow =
    completeMonths.length > 0
      ? completeMonths.reduce((s, m) => s + m.inflow, 0) / completeMonths.length
      : 0
  const avgMonthlyOutflow =
    completeMonths.length > 0
      ? completeMonths.reduce((s, m) => s + m.outflow, 0) / completeMonths.length
      : 0
  const netMonthlyCashFlow =
    completeMonths.length > 0
      ? completeMonths.reduce((s, m) => s + m.net, 0) / completeMonths.length
      : 0
  const avgDailyOutflow = avgMonthlyOutflow / DAYS_PER_MONTH

  const completeMonthLabels = completeMonths.map((m) => monthLabel(m.monthKey))
  const cashHistoryBasis =
    completeMonths.length > 0
      ? `Averaged over ${completeMonths.length} complete month${completeMonths.length === 1 ? '' : 's'} of bank history`
      : 'No complete months of bank history yet'

  // ---- Cash position ----
  const cashResult = computeAvailableOperatingCash({
    cashOnHand: cash.cashOnHand,
    minCashReserve: cash.minCashReserve,
    receivables: cash.receivables,
    obligationsDue: cash.obligations30,
    obligationsBasis: 'Active unpaid recurring obligations due within 30 days',
    unscheduledObligations: cash.unscheduledObligations,
    unscheduledObligationNames: cash.unscheduledObligationNames,
    monthlyDebtService: cash.monthlyDebtService,
    payrollDue: payrollMonthly,
    payrollBasis,
    expectedInflow: avgMonthlyInflow,
    inflowBasis: `Sales you typically collect in a month. ${cashHistoryBasis}.`,
    expectedOutflow: avgMonthlyOutflow,
    outflowBasis: `Everything that typically leaves the bank in a month — payroll, inventory, bills and loans. ${cashHistoryBasis}.`,
  })
  const daysCashOnHand =
    avgDailyOutflow > 0 ? Math.max(0, cashResult.projectedCash) / avgDailyOutflow : 0

  const reserveCoverage =
    cash.minCashReserve > 0
      ? cashResult.projectedCash / cash.minCashReserve
      : cashResult.projectedCash > 0
        ? 2
        : 0
  const creditUtilization =
    cash.creditLimitTotal > 0 ? cash.creditDrawn / cash.creditLimitTotal : 0
  const payrollPct =
    trailingMonthlyRevenue > 0 ? (payrollMonthly / trailingMonthlyRevenue) * 100 : 0

  // ---- Affordability ceiling (Step 8 safety rules) ----
  // Never more than the cash above the reserve. Anything beyond that would have
  // to come from the reserve, the credit line, or by delaying somebody's payment.
  const additionalSafe = Math.max(0, roundCents(cashResult.availableOperatingCash))
  const maxSafeTotal = roundCents(committedMonthly + additionalSafe)

  // ---- Seasonality ----
  const targetMonthKey = addMonths(
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`,
    1,
  )
  const seasonality = computeSeasonality(revRows, targetMonthKey)
  const seasonalIndex = seasonality.nextMonth?.index ?? 1

  // ---- Recommendation ----
  const budget = computeRecommendedBudget({
    trailingMonthlyRevenue,
    baselinePct: cash.baselinePct,
    ceilingPct: cash.ceilingPct,
    maxSafeTotal,
    seasonalIndex,
    revenueTrendPct,
    reserveCoverage,
    payrollPct,
    targetPayrollPct: cash.targetPayrollPct,
    creditUtilization,
  })

  const score = scoreAffordability({
    reserveCoverage,
    daysCashOnHand,
    daysCashTarget: cash.daysCashTarget,
    netMonthlyCashFlow,
    trailingMonthlyRevenue,
    payrollPct,
    targetPayrollPct: cash.targetPayrollPct,
    creditUtilization,
    additionalSafe,
  })

  const scenarios = buildScenarios({
    projectedCash: cashResult.projectedCash,
    minCashReserve: cash.minCashReserve,
    avgDailyOutflow,
    increments: SCENARIO_INCREMENTS,
  })

  // Which figure represents "what we spend today". The committed obligation is
  // the number the owner signed up for; `typicalMonthly` is the real long-run
  // rate from the bank (stale-proof, unlike the trailing 3-month average that
  // produced the "$16/month" figure). Use the larger so a recommendation can
  // never quietly imply a cut the owner has not agreed to.
  const currentMonthlyMarketing = Math.max(committedMonthly, spend.typicalMonthly)

  const recommendation = buildRecommendation({
    band: score.band,
    currentMonthlyMarketing,
    recommended: budget.recommended,
    additionalSafe,
    reserveCoverage,
    revenueTrendPct,
    seasonalIndex,
    seasonalLabel: seasonality.nextMonth?.label ?? null,
    payrollPct,
    targetPayrollPct: cash.targetPayrollPct,
    obligationsDue: cash.obligations30,
    unscheduledObligations: cash.unscheduledObligations,
    boundBy: budget.boundBy,
  })

  // ---- Confidence ----
  const spendRows = txns.filter(
    (t) =>
      t.reviewStatus !== 'excluded' &&
      SPEND_TYPES.includes(t.transactionType as TransactionType),
  )
  const spendDollars = spendRows.reduce((s, t) => s + Math.abs(t.amount), 0)
  const categorizedDollars = spendRows
    .filter((t) => t.expenseCategory.trim() !== '')
    .reduce((s, t) => s + Math.abs(t.amount), 0)

  const confidence = computeConfidence({
    revenueMonths: revRows.length,
    revenueMonthsFromApi: revenue.fromApi,
    categorizedSpendPct: spendDollars > 0 ? categorizedDollars / spendDollars : 0,
    incompleteMonths: monthly.incompleteMonths.map(monthLabel),
    gapMonths: monthly.gapMonths.map(monthLabel),
    totalMonthsCovered: monthly.series.length,
    balancesUpdatedDaysAgo: daysBetween(cash.balancesUpdatedAt, today),
    hasRealReceivables: cashResult.expectedReceivables > 0,
    excludedReceivableCount: cashResult.excludedReceivables.length,
  })

  // Surface a disagreement between the committed line and reality rather than
  // silently picking one. Either the budget is not being spent, or marketing is
  // hiding in the uncategorized pile.
  const mismatchGap = committedMonthly - spend.typicalMonthly
  const commitmentMismatch =
    committedMonthly > 0 && Math.abs(mismatchGap) > Math.max(50, committedMonthly * 0.25)
      ? {
          committed: committedMonthly,
          actual: roundCents(spend.typicalMonthly),
          note:
            mismatchGap > 0
              ? `A ${formatMoney(committedMonthly)}/month marketing obligation is on file, but marketing has averaged ${formatMoney(spend.typicalMonthly)}/month in the bank. Either the budget is not being spent, or some marketing is still sitting in the uncategorized transactions.`
              : `Actual marketing spend of ${formatMoney(spend.typicalMonthly)}/month is running above the ${formatMoney(committedMonthly)}/month obligation on file.`,
        }
      : null

  // Freshness is anchored on the newest bank transaction, not the balance
  // "updated_at" timestamp: a balance can be re-saved while the transaction feed
  // itself is weeks behind. 10 days is the threshold — beyond a week, a month
  // like this one is materially incomplete.
  const latestTransactionDate =
    txns.reduce<string | null>(
      (latest, t) =>
        t.transactionDate && (!latest || t.transactionDate > latest)
          ? t.transactionDate
          : latest,
      null,
    ) ?? null
  const freshnessDaysBehind = daysBetween(latestTransactionDate, today)

  return {
    spend,
    uncategorizedMarketing,
    reconciliation,
    dataFreshness: {
      latestTransactionDate,
      daysBehind: freshnessDaysBehind,
      isStale: freshnessDaysBehind !== null && freshnessDaysBehind > 10,
    },
    cash: cashResult,
    budget,
    score,
    scenarios,
    seasonality,
    confidence,
    recommendation,
    maxSafeTotal,
    additionalSafe,
    committedMonthly,
    commitmentMismatch,
    metrics: {
      trailingMonthlyRevenue,
      trailingRevenue12,
      revenueTrendPct,
      netMonthlyCashFlow,
      avgDailyOutflow,
      daysCashOnHand,
      daysCashTarget: cash.daysCashTarget,
      payrollPct,
      payrollMonthly,
      reserveCoverage,
      creditUtilization,
      targetMonthKey,
      targetMonthLabel: seasonality.nextMonth?.label ?? monthLabel(targetMonthKey),
    },
    roi: [],
    hasData: txns.length > 0 && revRows.length > 0,
  }
}
