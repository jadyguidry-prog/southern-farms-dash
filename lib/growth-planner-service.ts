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
  findDueDateConflicts,
  type CardSafetySummary,
  type DueDateConflict,
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
import {
  analyzeProposal,
  type Proposal,
  type ProposalDecision,
} from '@/lib/growth-proposals'

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
    headlineStressSalesDeclinePct: Number(r.headline_stress_sales_decline_pct),
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

  /**
   * The RECOMMENDED amounts: largest that still clear every gate through a sales
   * decline of `activeMode.headlineStressSalesDeclinePct`. Use these for the
   * headline.
   */
  maxRecurring: number
  maxOneTime: number

  /**
   * The largest amounts the limits tolerate on the EXPECTED path, with no downturn
   * applied. Higher than the recommended figures and much closer to failure — shown
   * as the ceiling, never as the recommendation.
   */
  edgeRecurring: number
  edgeOneTime: number

  /**
   * The commitment the scenario matrix was actually run against — the headline
   * recommendation, or the owner's custom amount when one was supplied. Exposed
   * so the UI can state WHICH figure was stress-tested rather than implying the
   * downturn columns apply to some unnamed amount.
   */
  stressCommitment: Commitment
  scenarios: ScenarioResult[]

  /**
   * Card statements falling due within `cardDueWindowDays` of today. The monthly
   * projection cannot see these — a commitment can clear every month-level gate and
   * still leave a statement short days later.
   */
  dueDateConflicts: DueDateConflict[]
  cardDueWindowDays: number

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

/**
 * Local calendar date as YYYY-MM-DD.
 *
 * Deliberately NOT `toISOString().slice(0, 10)`, which converts to UTC first and so
 * reports tomorrow's date for any evening local time. `findDueDateConflicts` parses
 * dates as local midnight, so a UTC-shifted "today" would offset every gap by a day
 * and could hide or invent a statement collision.
 */
function toISODate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
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
    const cycleStaleAfterDays = requireSetting(
      settings,
      'card_statement_cycle_stale_days',
    )
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
          statementPeriodStart: a.statementPeriodStart,
          statementPeriodEnd: a.statementPeriodEnd,
          lastUpdated: a.lastUpdated,
        })),
      today,
      { staleAfterDays, cycleStaleAfterDays },
    )

    // ---- Does a commitment now collide with a statement coming due? ------
    // Ordinary trap: a purchase made days before a large statement can leave the
    // statement short even though each looked affordable on its own. The planner
    // works in whole months, so this is the one check operating in days -- without
    // it a commitment can clear every monthly gate and still bounce a card.
    //
    // Uses today's date because that is when an approved commitment would be made.
    const cardDueWindowDays = requireSetting(settings, 'card_due_window_days')
    const dueDateConflicts = findDueDateConflicts(cards, toISODate(today), {
      windowDays: cardDueWindowDays,
    })

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

    // Two different questions, deliberately both answered.
    //
    // The EDGE is the largest amount the limits tolerate on the expected path. It is
    // the mathematically correct maximum, and it is what the ladder shows -- but it
    // sits at the boundary of failure. Observed Aug 2026: the edge was $3,029/mo,
    // which left a $1 cushion and broke on a 5% sales dip.
    //
    // The HEADLINE is the largest amount that still clears every gate through the
    // mode's required downturn. That is the number the owner acts on, so resilience
    // has to be built into it rather than bolted on as a warning underneath.
    const edgeRecurring = maxSupported(assumptions, activeMode, coverage, 'recurring')
    const edgeOneTime = maxSupported(assumptions, activeMode, coverage, 'one-time')

    const declinePct = activeMode.headlineStressSalesDeclinePct
    const headlineStress = { inflowMultiplier: 1 - declinePct / 100 }
    const maxRecurring = maxSupported(assumptions, activeMode, coverage, 'recurring', {
      stress: headlineStress,
    })
    const maxOneTime = maxSupported(assumptions, activeMode, coverage, 'one-time', {
      stress: headlineStress,
    })

    // ---- Stress test the headline number, not a hypothetical ------------
    // The number the owner will act on is the headline recommendation, so that is
    // what must survive a downturn. Testing an arbitrary amount instead would let
    // the page claim resilience it never checked. If a custom amount was asked
    // for, that is the figure under consideration and takes precedence.
    const stressCommitment: Commitment =
      (opts?.customRecurring != null && opts.customRecurring > 0) ||
      (opts?.customOneTime != null && opts.customOneTime > 0)
        ? {
            recurringMonthly: opts?.customRecurring ?? 0,
            oneTime: opts?.customOneTime ?? 0,
          }
        : maxRecurring > 0
          ? { recurringMonthly: maxRecurring, oneTime: 0 }
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
      edgeRecurring,
      edgeOneTime,
      dueDateConflicts,
      cardDueWindowDays,
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

/**
 * Analyse a typed proposal against the live snapshot.
 *
 * Thin orchestration: it loads the SAME snapshot the ladder uses and hands the
 * pure `analyzeProposal` its assumptions, coverage, active mode, strategy and
 * confidence gaps. No money math happens here, so a proposal and the ladder can
 * never disagree about what the business can absorb. `todayISO` is read once, here
 * at the impure edge, and passed down so the analyzer stays clock-free and
 * testable.
 */
export async function analyzeProposalFromSnapshot(
  proposal: Proposal,
  opts?: {
    modeKey?: string
    assumedMarginPct?: number | null
    customSalesDeclinePct?: number | null
  },
): Promise<{
  decision: ProposalDecision
  evaluation: RungEvaluation
  scenarios: ScenarioResult[]
  activeModeLabel: string
  /** The mode actually used — a blank `modeKey` resolves to the active default, and
   *  callers that persist a proposal need the concrete key to reproduce this lens. */
  resolvedModeKey: string
  confidencePct: number
}> {
  const [snap, settings] = await Promise.all([
    getGrowthPlannerSnapshot({ modeKey: opts?.modeKey }),
    getBusinessSettings(),
  ])

  const reviewCadenceMonths = requireSetting(settings, 'growth_review_cadence_months')
  const today = new Date()

  const { decision, evaluation, scenarios } = analyzeProposal({
    proposal,
    assumptions: snap.assumptions,
    mode: snap.activeMode,
    cov: snap.coverage,
    strategy: snap.strategy,
    confidenceGaps: snap.meta.confidenceGaps,
    todayISO: toISODate(today),
    reviewCadenceMonths,
    assumedMarginPct: opts?.assumedMarginPct ?? null,
    customSalesDeclinePct: opts?.customSalesDeclinePct ?? null,
  })

  return {
    decision,
    evaluation,
    scenarios,
    activeModeLabel: snap.activeMode.label,
    resolvedModeKey: snap.activeMode.modeKey,
    confidencePct: snap.meta.confidencePct,
  }
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
