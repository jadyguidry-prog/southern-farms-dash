/**
 * Growth Investment Planner — data loading and orchestration.
 *
 * This file is an ORCHESTRATOR, not a second source of truth for money. Every
 * cash figure comes from the existing engine (`getMarketingAffordabilitySnapshot`),
 * so the Planner, the Marketing page, Cash Flow and the Dashboard cannot drift
 * apart. The deterministic math lives in `lib/growth-planner.ts`.
 */

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import {
  getBankAccounts,
  getBusinessSettings,
  getMarketingAffordabilitySnapshot,
} from '@/lib/queries'
import {
  assessCardSafety,
  CARD_ACCOUNT_TYPE,
  type CardSafetySummary,
} from '@/lib/card-safety'
import {
  assessStrategicTiming,
  buildCapacityLadder,
  buildScenarioMatrix,
  evaluateRung,
  maxSupported,
  NO_COMMITMENT,
  projectMonths,
  type Commitment,
  type CoverageInputs,
  type LadderRung,
  type ProjectedMonth,
  type ProjectionAssumptions,
  type RiskMode,
  type RungEvaluation,
  type ScenarioResult,
  type StrategicTiming,
} from '@/lib/growth-planner'

/* ------------------------------------------------------------------ */
/* Risk modes                                                          */
/* ------------------------------------------------------------------ */

/**
 * Load the owner-tunable risk modes.
 *
 * Throws rather than returning defaults. A missing thresholds table must not
 * silently become a permissive planner: an invented threshold that lets an
 * unaffordable commitment through is worse than an error message.
 */
export const getRiskModes = cache(async (): Promise<RiskMode[]> => {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('growth_risk_modes')
    .select('*')
    .order('sort_order', { ascending: true })

  if (error) throw new Error(`growth_risk_modes: ${error.message}`)
  if (!data || data.length === 0) {
    throw new Error(
      'growth_risk_modes is empty. The planner refuses to guess safety thresholds.',
    )
  }

  return data.map((r) => ({
    modeKey: String(r.mode_key),
    label: String(r.label),
    description: String(r.description ?? ''),
    isDefault: Boolean(r.is_default),
    reserveFloorPct: Number(r.reserve_floor_pct),
    minDaysCash: Number(r.min_days_cash),
    locAllowed: Boolean(r.loc_allowed),
    maxLocUtilizationPct: Number(r.max_loc_utilization_pct),
    minPayrollCoverageMonths: Number(r.min_payroll_coverage_months),
    minVendorCoverageMonths: Number(r.min_vendor_coverage_months),
    minDebtCoverageMonths: Number(r.min_debt_coverage_months),
  }))
})

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

export type GrowthPlannerSnapshot = {
  hasData: boolean

  modes: RiskMode[]
  activeMode: RiskMode

  assumptions: ProjectionAssumptions
  coverage: CoverageInputs

  /** Baseline projection with no new commitment. */
  baseline: ProjectedMonth[]
  baselineEvaluation: RungEvaluation

  ladder: LadderRung[]
  /** Largest recurring / one-time amount that clears every gate exactly. */
  maxRecurring: number
  maxOneTime: number

  strategy: StrategicTiming
  cards: CardSafetySummary

  /**
   * The 7-day daily forecast low point, carried through for display ONLY.
   * Deliberately kept distinct from the monthly horizon: they measure different
   * things and must never be shown as the same number.
   */
  nearTerm: {
    lowestCash: number | null
    horizonDays: number
  }

  meta: {
    horizonMonths: number
    startMonthKey: string
    minCashReserve: number
    staleAfterDays: number
    inflowBasis: string
    outflowBasis: string
    /** Confidence carried from the existing engine, reduced for stale cards. */
    confidencePct: number
    confidenceGaps: string[]
    dataFreshness: {
      latestTransactionDate: string | null
      daysBehind: number | null
      isStale: boolean
    }
  }
}

/** Next calendar month after `today`, as `YYYY-MM`. */
function nextMonthKey(today: Date): string {
  const y = today.getUTCFullYear()
  const m = today.getUTCMonth() // 0-based
  const d = new Date(Date.UTC(y, m + 1, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Read a setting that must exist.
 *
 * Never `?? 0`. A failed settings read once reported a $0 reserve and $16,185
 * spendable when the truth was $15,000 and $1,437, so a missing row is an error.
 */
function requireSetting(
  settings: Awaited<ReturnType<typeof getBusinessSettings>>,
  key: string,
): number {
  const row = settings.rows.find((r) => r.key === key)
  if (!row || !Number.isFinite(row.value)) {
    throw new Error(
      `business_settings.${key} is missing or not a number. The planner will not substitute a guess.`,
    )
  }
  return row.value
}

export const getGrowthPlannerSnapshot = cache(
  async (opts?: {
    modeKey?: string
    customRecurring?: number | null
    customOneTime?: number | null
    /** Owner's own stress test: the sales drop they actually fear. */
    customSalesDeclinePct?: number | null
  }): Promise<GrowthPlannerSnapshot> => {
    const [affordability, accounts, settings, modes] = await Promise.all([
      getMarketingAffordabilitySnapshot(),
      getBankAccounts(),
      getBusinessSettings(),
      getRiskModes(),
    ])

    const activeMode =
      modes.find((m) => m.modeKey === opts?.modeKey) ??
      modes.find((m) => m.isDefault) ??
      modes[0]

    const horizonMonths = requireSetting(settings, 'growth_horizon_months')
    const staleAfterDays = requireSetting(settings, 'account_data_stale_days')
    const minCashReserve = requireSetting(settings, 'min_cash_reserve')

    const today = new Date()
    const startMonthKey = nextMonthKey(today)

    // ---- Card safety from real account rows -----------------------------
    // Cards ONLY. `assessCardSafety` accepts every credit account, which includes
    // 'Line of Credit', but this page reports card exposure and borrowing capacity
    // as two separate figures. Passing the line into both made the same $15,000 LOC
    // draw show up as card debt AND as available borrowing -- the same
    // double-counting class of bug as the Square Capital offer. Keeping the two
    // disjoint here means "Credit cards" reports only real cards, and correctly
    // says nothing is tracked until the Amex balances are entered.
    const cards = assessCardSafety(
      accounts
        .filter((a) => a.accountType === CARD_ACCOUNT_TYPE)
        .map((a) => ({
          id: a.id,
          accountName: a.accountName,
          accountType: a.accountType,
          currentBalance: a.currentBalance,
          creditLimit: a.creditLimit,
          availableCredit: a.availableCredit,
          statementBalance: a.statementBalance,
          statementDueDate: a.statementDueDate,
          lastUpdated: a.lastUpdated,
        })),
      today,
      { staleAfterDays },
    )

    // ---- Line of credit, excluding cards -------------------------------
    // Cards are assessed separately by `assessCardSafety`; only the revolving
    // line is treated as a source of funds for a commitment.
    const locAccounts = accounts.filter((a) => a.accountType === 'Line of Credit')
    const locDrawn = locAccounts.reduce((s, a) => s + a.currentBalance, 0)
    const locLimit = locAccounts.reduce((s, a) => s + a.creditLimit, 0)
    const locAvailable = locAccounts.reduce((s, a) => s + a.availableCredit, 0)

    const cash = affordability.cash
    const metrics = affordability.metrics

    const assumptions: ProjectionAssumptions = {
      cashOnHand: cash.cashOnHand,
      expectedReceivables: cash.expectedReceivables,
      expectedInflow: cash.expectedInflow,
      expectedOutflow: cash.expectedOutflow,
      horizonMonths,
      startMonthKey,
      seasonalIndex: buildSeasonalIndex(
        affordability.seasonality.months.map((m) => ({ month: m.month, index: m.index })),
        startMonthKey,
        horizonMonths,
      ),
    }

    const coverage: CoverageInputs = {
      minCashReserve,
      avgDailyOutflow: metrics.avgDailyOutflow,
      monthlyPayroll: metrics.payrollMonthly,
      // Not yet classified separately from general outflow. Left at 0 so the gate
      // is SKIPPED rather than judged against a number that does not exist.
      monthlyCriticalVendors: 0,
      monthlyDebtService: cash.deductions.find((d) => d.label === 'Loan payments')?.amount ?? 0,
      locDrawn,
      locLimit,
      locAvailable,
    }

    const baseline = projectMonths(assumptions, NO_COMMITMENT)
    const baselineEvaluation = evaluateRung(assumptions, NO_COMMITMENT, activeMode, coverage)

    const ladder = buildCapacityLadder(assumptions, activeMode, coverage, {
      customRecurring: opts?.customRecurring ?? null,
      customOneTime: opts?.customOneTime ?? null,
    })

    const strategy = assessStrategicTiming({
      startMonthKey,
      horizonMonths,
      seasonalIndex: assumptions.seasonalIndex ?? [],
      revenueTrendPct: metrics.revenueTrendPct,
    })

    // Confidence is carried from the existing engine and then REDUCED when card
    // data is stale or missing, so an out-of-date card balance can never make an
    // unsafe commitment look safe.
    const gaps = [...affordability.confidence.gaps, ...cards.warnings]
    let confidencePct = affordability.confidence.recommendation.pct
    if (cards.confidence === 'missing') confidencePct = Math.min(confidencePct, 60)
    else if (cards.confidence === 'reduced') confidencePct = Math.min(confidencePct, 80)

    const maxRecurring = maxSupported(assumptions, activeMode, coverage, 'recurring')
    const maxOneTime = maxSupported(assumptions, activeMode, coverage, 'one-time')

    // ---- Stress test the headline number, not a hypothetical ------------
    // The number the owner will act on is the headline recommendation, so that is
    // what must survive a downturn. Testing an arbitrary amount instead would let
    // the page claim resilience it never checked. If a custom amount was asked
    // for, that is the figure under consideration and takes precedence.
    const stressCommitment: Commitment =
      opts?.customRecurring != null && opts.customRecurring > 0
        ? { kind: 'recurring', amount: opts.customRecurring }
        : maxRecurring > 0
          ? { kind: 'recurring', amount: maxRecurring }
          : NO_COMMITMENT

    const scenarios = buildScenarioMatrix(assumptions, stressCommitment, activeMode, coverage, {
      customSalesDeclinePct: opts?.customSalesDeclinePct ?? null,
    })

    return {
      hasData: affordability.hasData,
      modes,
      activeMode,
      assumptions,
      coverage,
      baseline,
      baselineEvaluation,
      ladder,
      stressCommitment,
      scenarios,
      maxRecurring,
      maxOneTime,
      strategy,
      cards,
      nearTerm: {
        lowestCash: null,
        horizonDays: 7,
      },
      meta: {
        horizonMonths,
        startMonthKey,
        minCashReserve,
        staleAfterDays,
        inflowBasis: cash.inflowBasis,
        outflowBasis: cash.outflowBasis,
        confidencePct,
        confidenceGaps: gaps,
        dataFreshness: affordability.dataFreshness,
      },
    }
  },
)

/**
 * Align calendar-month seasonal indices to the projection horizon.
 *
 * Exported so the verify script can check the alignment against the same code the
 * page uses — an off-by-one here would silently move the projected low point into
 * the wrong month.
 */
export function buildSeasonalIndex(
  months: { month: number; index: number }[],
  startMonthKey: string,
  horizonMonths: number,
): number[] {
  const byMonth = new Map(months.map((m) => [m.month, m.index]))
  const startMonth = Number(startMonthKey.slice(5, 7))
  const out: number[] = []
  for (let i = 0; i < horizonMonths; i++) {
    const cal = ((startMonth - 1 + i) % 12) + 1
    // Missing history means "assume average", never "assume zero revenue".
    out.push(byMonth.get(cal) ?? 1)
  }
  return out
}

/** Evaluate one specific commitment — used by the scenario matrix on the page. */
export async function evaluateCommitment(
  commitment: Commitment,
  opts?: { modeKey?: string; customSalesDeclinePct?: number | null },
): Promise<{
  evaluation: RungEvaluation
  scenarios: ScenarioResult[]
  months: ProjectedMonth[]
}> {
  const snap = await getGrowthPlannerSnapshot({ modeKey: opts?.modeKey })
  return {
    evaluation: evaluateRung(snap.assumptions, commitment, snap.activeMode, snap.coverage),
    scenarios: buildScenarioMatrix(
      snap.assumptions,
      commitment,
      snap.activeMode,
      snap.coverage,
      { customSalesDeclinePct: opts?.customSalesDeclinePct ?? null },
    ),
    months: projectMonths(snap.assumptions, commitment),
  }
}
