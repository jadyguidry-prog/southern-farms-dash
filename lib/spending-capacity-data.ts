/**
 * Live data loading for spending capacity.
 *
 * Kept separate from `spending-capacity-service.ts` on purpose: that module is
 * pure and unit-tested with no database, and this one is the only place that
 * touches Supabase. The split also keeps server-only imports out of any bundle
 * that a client component might pull the maths into.
 */
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { fetchAllPages } from '@/lib/paginate'
import { getBusinessSettings, getCashDebtSummary } from '@/lib/queries'
import { getObligationPayments, type ObligationPayment } from '@/lib/bill-pay-service'
import { getCardExposure } from '@/lib/card-exposure-service'
import type { ForecastCardPayment } from '@/lib/card-activity'
import {
  addDays,
  assembleCapacity,
  formatDate,
  isoDayOfWeek,
  parseDate,
  type CapacityConfidence,
  type CapacityResult,
  type FlowEstimate,
  type LedgerRow,
} from '@/lib/spending-capacity-service'

/** Round to cents, mirroring the engine so the two layers cannot drift. */
function money(n: number) {
  return Math.round(n * 100) / 100
}

export type SpendingCapacity = CapacityResult & {
  confidence: CapacityConfidence
  estimate: FlowEstimate
  cashOnHand: number
  minCashReserve: number
  /** 30-day series for the existing forecast chart. */
  thirtyDay: { day: string; balance: number; cautious: number }[]
  /** Which accounts were treated as spendable cash, for the UI to disclose. */
  operatingAccounts: string[]
  lastLedgerDate: string
  /** The date the projection starts from, so the UI never re-reads the clock itself. */
  today: string
  /** Card payoffs charged on their due date, so the UI can name the cliff. */
  cardPayments: ForecastCardPayment[]
  /** Cards that could NOT be forecast, and why. Shown so a gap is never silent. */
  blockedCardPayments: ForecastCardPayment[]
  /**
   * Undrawn credit on revolving LINES OF CREDIT, as context for a negative trough.
   *
   * Deliberately NOT added to cash and NOT fed into any projection: borrowing is not money
   * you have, and folding it in would inflate "safe to spend" with debt. It is reported
   * only because a forecast that shows a big shortfall while ignoring a real, drawable
   * buffer reads as more dire than the true position.
   *
   * `null` means NOT TRACKED (no limit recorded), which must never render as $0 — a
   * literal zero reads as "fully drawn" and would overstate exposure.
   *
   * Credit CARDS are excluded on purpose: card headroom cannot cover payroll or an ACH
   * vendor draft, so counting it as a cash buffer would be misleading.
   */
  availableCredit: number | null
  creditLines: { accountName: string; limit: number; drawn: number; available: number }[]
}

/**
 * Assemble the spending-capacity view from live records.
 *
 * Deliberate choices, each one load-bearing:
 * - Credit cards are excluded from operating cash. A card purchase is not cash
 *   leaving; counting it and its later payoff double-counts the same spend.
 * - Starts from RAW bank balance, then subtracts outstanding checks and pending
 *   drafts on their own dates. Starting from a figure that already nets them out
 *   would charge every uncleared payment twice.
 * - Vendors that appear as dated items are removed from the estimated baseline
 *   for the same reason.
 */
export const getSpendingCapacity = cache(async (): Promise<SpendingCapacity> => {
  const supabase = await createClient()
  const today = formatDate(new Date())

  const [{ data: accounts }, settings, summary, payments, exposure, { data: cardMatchers }] =
    await Promise.all([
      supabase
        .from('bank_accounts')
        .select('account_name, account_type, current_balance, credit_limit, closed_at'),
      getBusinessSettings(),
      getCashDebtSummary(),
      getObligationPayments().catch((err) => {
        // Bill Pay is optional. Losing it must degrade the explanation, not the number.
        console.log('[v0] getSpendingCapacity: obligation payments unavailable:', err)
        return [] as ObligationPayment[]
      }),
      // Reuse the SHARED card loader rather than re-reading balances here. It already
      // encodes the rule that an unconfirmed balance is null and not 0, and sharing it
      // means the forecast cannot disagree with the card panel about what is owed.
      getCardExposure().catch((err) => {
        console.log('[v0] getSpendingCapacity: card exposure unavailable:', err)
        return null
      }),
      supabase.from('bank_accounts').select('account_name, payment_description_match'),
    ])

  const matcherByAccount = new Map(
    (cardMatchers ?? []).map((r) => [r.account_name as string, r.payment_description_match as string | null]),
  )

  // Only real cards. A line of credit has no statement cycle, so it must not be forecast
  // as a dated payoff.
  const cards = (exposure?.cards ?? []).map((c) => ({
    accountName: c.accountName,
    closedAt: c.closedAt,
    balanceOwed: c.owed,
    statementDueDate: c.statementDueDate,
    paymentDescriptionMatch: matcherByAccount.get(c.accountName) ?? null,
  }))

  // The ledger labels accounts by bank name while `bank_accounts` uses friendly
  // names, so resolve the ledger's own labels rather than assuming they match.
  type LedgerQueryRow = {
    transaction_date: string | null
    description: string | null
    amount: number | string | null
    transaction_type: string | null
    account_name: string | null
  }

  // Paginated: PostgREST silently caps responses at 1,000 rows, and a truncated
  // history would quietly bias every median computed below.
  const ledgerRows = await fetchAllPages<LedgerQueryRow>(
    (from, to) =>
      supabase
        .from('financial_transactions')
        .select('transaction_date, description, amount, transaction_type, account_name')
        .is('deleted_at', null)
        .not('account_name', 'is', null)
        .order('transaction_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    'getSpendingCapacity ledger',
  )

  const rows: LedgerRow[] = (ledgerRows ?? []).map((r) => ({
    date: String(r.transaction_date ?? '').slice(0, 10),
    description: r.description ?? '',
    amount: Number(r.amount ?? 0),
    type: r.transaction_type ?? '',
    accountName: r.account_name ?? '',
  }))

  // Single shared assembly, also used by scripts/verify-cash-reconciliation.ts so
  // the verified figures are the same ones this page renders.
  const {
    result,
    estimate,
    confidence,
    shares,
    cashOnHand,
    operatingAccounts,
    lastLedgerDate,
    cardPayments,
    blockedCardPayments,
  } = assembleCapacity({
    accounts: accounts ?? [],
    rows,
    obligations: summary.scheduledObligations,
    payments,
    minCashReserve: settings.min_cash_reserve,
    today,
    cards,
    horizonDays: settings.cash_forecast_horizon_days,
    nearTermDays: settings.cash_near_term_days,
  })

  // ---- Undrawn credit, reported beside the trough but never folded into it ----
  //
  // Restricted to `Line of Credit` accounts. A revolving line can be drawn to cover an
  // ACH draft or payroll; card headroom cannot, so treating the two alike would present
  // a buffer the business can't actually deploy against these obligations.
  const creditLines = (accounts ?? [])
    .filter((a) => {
      if (a.closed_at) return false
      if (!/line of credit/i.test(String(a.account_type ?? ''))) return false
      // A missing or zero limit is "not recorded", not a $0 line. Excluded so it cannot
      // contribute a fake zero to the total.
      return Number(a.credit_limit ?? 0) > 0
    })
    .map((a) => {
      const limit = Number(a.credit_limit ?? 0)
      const drawn = Number(a.current_balance ?? 0)
      return {
        accountName: String(a.account_name ?? ''),
        limit: money(limit),
        drawn: money(drawn),
        // Clamped at 0: an over-limit line is not negative borrowing capacity.
        available: money(Math.max(0, limit - drawn)),
      }
    })

  // Null, not 0, when no line has a recorded limit — the distinction between "nothing
  // available" and "we don't know" is the whole point.
  const availableCredit =
    creditLines.length > 0 ? money(creditLines.reduce((s, l) => s + l.available, 0)) : null

  // ---- Chart series, derived from the ENGINE's own days ----
  //
  // This previously re-implemented the projection loop by hand, which is precisely how a
  // chart ends up disagreeing with the headline above it: two copies of the same
  // arithmetic drift the moment one is updated. `result.days` now spans the configured
  // horizon, so the chart just reads it.
  const thirtyDay: SpendingCapacity['thirtyDay'] = result.days.map((d) => ({
    day: parseDate(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    balance: d.typicalBalance,
    cautious: d.cautiousBalance,
  }))

  return {
    ...result,
    confidence,
    estimate,
    cashOnHand,
    minCashReserve: settings.min_cash_reserve,
    thirtyDay,
    operatingAccounts,
    lastLedgerDate,
    today,
    cardPayments,
    blockedCardPayments,
    availableCredit,
    creditLines,
  }
})
