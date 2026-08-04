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
  /** Card payoffs charged on their due date, so the UI can name the cliff. */
  cardPayments: ForecastCardPayment[]
  /** Cards that could NOT be forecast, and why. Shown so a gap is never silent. */
  blockedCardPayments: ForecastCardPayment[]
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
      supabase.from('bank_accounts').select('account_name, account_type, current_balance'),
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
    cardPayments,
    blockedCardPayments,
  }
})
