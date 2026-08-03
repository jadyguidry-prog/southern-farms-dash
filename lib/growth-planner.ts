/**
 * Growth Investment Planner — deterministic math.
 *
 * Pure functions only: no database, no AI, no clock reads. Everything here is fed
 * explicit inputs so the verify script can exercise the SAME code the page renders
 * rather than re-implementing it (that drift is how this project once reported a
 * $0 reserve when the truth was $15,000).
 *
 * Two horizons exist on purpose and must stay labelled distinctly in the UI:
 *   - the existing 7-day DAILY forecast (`deriveSpendingCapacity`) for near-term
 *     "lowest cash point", and
 *   - the MONTHLY horizon here (default 6 months) for judging recurring costs.
 * A $1,200/month agency retainer cannot be assessed in a week, so the ladder uses
 * the monthly horizon. The two numbers legitimately differ; they are not in
 * conflict, and the page must never present them as the same measure.
 */

import { addMonths } from '@/lib/marketing-affordability-service'

/* ------------------------------------------------------------------ */
/* Risk modes — thresholds are DATA, loaded from `growth_risk_modes`   */
/* ------------------------------------------------------------------ */

export type RiskMode = {
  modeKey: string
  label: string
  description: string
  isDefault: boolean
  /**
   * Percent of the cash reserve target that must survive. 100 = untouchable.
   * Below 100 the mode tolerates compression, which is surfaced as a TRADEOFF
   * (`tradeoffs`), never silently treated as safe.
   */
  reserveFloorPct: number
  minDaysCash: number
  locAllowed: boolean
  maxLocUtilizationPct: number
  minPayrollCoverageMonths: number
  minVendorCoverageMonths: number
  minDebtCoverageMonths: number
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

/** A commitment being tested. Either or both parts may be zero. */
export type Commitment = {
  recurringMonthly: number
  oneTime: number
}

export const NO_COMMITMENT: Commitment = { recurringMonthly: 0, oneTime: 0 }

export type ProjectionAssumptions = {
  cashOnHand: number
  /** Receivables genuinely expected to land; credited in month 1 only. */
  expectedReceivables: number
  /** Typical money in per month, before any scenario multiplier. */
  expectedInflow: number
  /** Typical money out per month, before any scenario multiplier. */
  expectedOutflow: number
  horizonMonths: number
  /** First projected month, `YYYY-MM`. */
  startMonthKey: string
  /**
   * Per-month seasonal index aligned to the horizon (1 = an average month).
   * Shapes WHEN money arrives, and therefore where the low point falls. Omitted
   * means every month is treated as average.
   */
  seasonalIndex?: number[]
  /** Scenario stress on revenue. 0.9 = sales down 10%. */
  inflowMultiplier?: number
  /** Scenario stress on costs. 1.1 = costs up 10%. */
  outflowMultiplier?: number
}

export type ProjectedMonth = {
  offset: number
  monthKey: string
  openingCash: number
  inflow: number
  outflow: number
  /** Cost of the commitment charged in this month. */
  commitmentCost: number
  closingCash: number
}

/**
 * Walk cash forward month by month.
 *
 * The one-time cost hits month 1; the recurring cost hits every month. Receivables
 * are credited once, in month 1, because a balance owed is collected once — adding
 * them every month would manufacture cash that does not exist.
 */
export function projectMonths(
  a: ProjectionAssumptions,
  commitment: Commitment,
): ProjectedMonth[] {
  const inflowMult = a.inflowMultiplier ?? 1
  const outflowMult = a.outflowMultiplier ?? 1
  const months: ProjectedMonth[] = []

  let cash = a.cashOnHand

  for (let i = 0; i < a.horizonMonths; i++) {
    const seasonal = a.seasonalIndex?.[i] ?? 1
    const openingCash = cash

    // Seasonality shapes revenue, not fixed costs: rent does not fall because
    // January is slow. Applying it to outflow too would cancel most of its effect
    // and hide exactly the lean months this is meant to expose.
    const inflow =
      a.expectedInflow * inflowMult * seasonal + (i === 0 ? a.expectedReceivables : 0)
    const outflow = a.expectedOutflow * outflowMult
    const commitmentCost =
      commitment.recurringMonthly + (i === 0 ? commitment.oneTime : 0)

    cash = openingCash + inflow - outflow - commitmentCost

    months.push({
      offset: i,
      monthKey: addMonths(a.startMonthKey, i),
      openingCash: round2(openingCash),
      inflow: round2(inflow),
      outflow: round2(outflow),
      commitmentCost: round2(commitmentCost),
      closingCash: round2(cash),
    })
  }

  return months
}

/* ------------------------------------------------------------------ */
/* Rung evaluation                                                     */
/* ------------------------------------------------------------------ */

export type Classification =
  | 'Very Safe'
  | 'Comfortable'
  | 'Supported'
  | 'Tight'
  | 'Not Supported'

/** Ordered worst → best, for sorting and comparison. */
export const CLASSIFICATION_ORDER: Classification[] = [
  'Not Supported',
  'Tight',
  'Supported',
  'Comfortable',
  'Very Safe',
]

export type CoverageInputs = {
  /** Cash reserve target in dollars, from `business_settings.min_cash_reserve`. */
  minCashReserve: number
  /** Average money out per day, used for the days-of-cash test. */
  avgDailyOutflow: number
  /** Monthly payroll. 0 means none on file — the gate then does not apply. */
  monthlyPayroll: number
  /** Monthly critical-vendor spend. 0 means none on file. */
  monthlyCriticalVendors: number
  /** Monthly loan payments. 0 means none on file. */
  monthlyDebtService: number
  /** Dollars already drawn on the line of credit. */
  locDrawn: number
  /** Total line-of-credit limit. */
  locLimit: number
  /** Undrawn credit genuinely available to borrow. */
  locAvailable: number
}

export type RungEvaluation = {
  endingCash: number
  /** Lowest month-end cash across the whole horizon — the figure that matters. */
  lowestProjectedCash: number
  lowestMonthKey: string
  /** Dollars the mode requires be left untouched. */
  reserveFloor: number
  /** Lowest cash minus the floor. Negative means the floor is breached. */
  reserveRemaining: number
  daysOfCash: number
  /** `null` where the cost does not exist on file, so the gate cannot apply. */
  payrollCoverageMonths: number | null
  vendorCoverageMonths: number | null
  debtCoverageMonths: number | null
  /** Borrowing needed to avoid going negative. 0 when none is required. */
  locRequired: number
  /** Line utilization after borrowing, 0–1. `null` when no limit is on file. */
  locUtilizationAfter: number | null
  /** True when the plan dips into the reserve target the mode permits spending. */
  reserveCompressed: boolean
  classification: Classification
  /** Hard-gate breaches. Non-empty means Not Supported. */
  failures: string[]
  /** Permitted by the mode but worth stating plainly. */
  tradeoffs: string[]
}

/**
 * Judge one commitment against one risk mode.
 *
 * Assessed on the LOWEST projected month, not the last one. A plan that ends the
 * horizon healthy but dips below the reserve in month 3 is not affordable — the
 * business has to survive every month, not just the final one.
 */
export function evaluateRung(
  assumptions: ProjectionAssumptions,
  commitment: Commitment,
  mode: RiskMode,
  cov: CoverageInputs,
): RungEvaluation {
  const months = projectMonths(assumptions, commitment)

  const endingCash = months.length > 0 ? months[months.length - 1].closingCash : cov.locDrawn * 0
  let lowest = months.length > 0 ? months[0].closingCash : 0
  let lowestMonthKey = months.length > 0 ? months[0].monthKey : assumptions.startMonthKey
  for (const m of months) {
    if (m.closingCash < lowest) {
      lowest = m.closingCash
      lowestMonthKey = m.monthKey
    }
  }

  const reserveFloor = round2((cov.minCashReserve * mode.reserveFloorPct) / 100)
  const reserveRemaining = round2(lowest - reserveFloor)

  // Days of cash is measured on the low point too, for the same reason.
  const daysOfCash = cov.avgDailyOutflow > 0 ? Math.max(0, lowest) / cov.avgDailyOutflow : 0

  const coverage = (monthlyCost: number): number | null =>
    monthlyCost > 0 ? Math.max(0, lowest) / monthlyCost : null

  const payrollCoverageMonths = coverage(cov.monthlyPayroll)
  const vendorCoverageMonths = coverage(cov.monthlyCriticalVendors)
  const debtCoverageMonths = coverage(cov.monthlyDebtService)

  const locRequired = lowest < 0 ? round2(-lowest) : 0
  const locUtilizationAfter =
    cov.locLimit > 0 ? Math.min(1, (cov.locDrawn + locRequired) / cov.locLimit) : null

  const failures: string[] = []
  const tradeoffs: string[] = []

  // --- Borrowing gates ---------------------------------------------------
  if (locRequired > 0) {
    if (!mode.locAllowed) {
      failures.push(
        `Would run ${money(locRequired)} short in ${lowestMonthKey} and ${mode.label} does not borrow to cover a shortfall.`,
      )
    } else if (locRequired > cov.locAvailable) {
      failures.push(
        `Would need to borrow ${money(locRequired)} but only ${money(cov.locAvailable)} of credit is available.`,
      )
    } else if (
      locUtilizationAfter !== null &&
      locUtilizationAfter * 100 > mode.maxLocUtilizationPct
    ) {
      failures.push(
        `Borrowing ${money(locRequired)} would put the credit line at ${(locUtilizationAfter * 100).toFixed(0)}%, above the ${mode.maxLocUtilizationPct}% limit for ${mode.label}.`,
      )
    } else {
      tradeoffs.push(
        `Requires borrowing ${money(locRequired)} in ${lowestMonthKey}, taking the credit line to ${locUtilizationAfter === null ? 'an unknown utilization' : `${(locUtilizationAfter * 100).toFixed(0)}%`}.`,
      )
    }
  }

  // --- Reserve gate ------------------------------------------------------
  if (reserveRemaining < 0) {
    failures.push(
      `Lowest projected cash of ${money(lowest)} in ${lowestMonthKey} falls ${money(Math.abs(reserveRemaining))} below the ${money(reserveFloor)} reserve floor for ${mode.label}.`,
    )
  }

  // Compression is a real cost even when the mode allows it, so say so.
  const reserveCompressed = mode.reserveFloorPct < 100 && lowest < cov.minCashReserve
  if (reserveCompressed && reserveRemaining >= 0) {
    tradeoffs.push(
      `Spends into the cash reserve: ${money(lowest)} at the low point against a ${money(cov.minCashReserve)} target. ${mode.label} permits this, but the cushion is genuinely thinner.`,
    )
  }

  // --- Days of cash ------------------------------------------------------
  if (cov.avgDailyOutflow > 0 && daysOfCash < mode.minDaysCash) {
    failures.push(
      `Leaves ${daysOfCash.toFixed(0)} days of cash at the low point, under the ${mode.minDaysCash}-day minimum for ${mode.label}.`,
    )
  }

  // --- Coverage gates ----------------------------------------------------
  // `null` coverage means the cost is not on file; a gate cannot be judged
  // against a cost that does not exist, so it is skipped rather than failed.
  const coverageGate = (
    actual: number | null,
    required: number,
    label: string,
  ): void => {
    if (actual === null) return
    if (actual < required) {
      failures.push(
        `Would leave ${actual.toFixed(1)} months of ${label} covered, under the ${required}-month minimum for ${mode.label}.`,
      )
    }
  }
  coverageGate(payrollCoverageMonths, mode.minPayrollCoverageMonths, 'payroll')
  coverageGate(vendorCoverageMonths, mode.minVendorCoverageMonths, 'critical vendor spend')
  coverageGate(debtCoverageMonths, mode.minDebtCoverageMonths, 'loan payments')

  // --- Classification ----------------------------------------------------
  let classification: Classification
  if (failures.length > 0) {
    classification = 'Not Supported'
  } else {
    // Graded on how much clearance sits above the floor, expressed against the
    // reserve target so the bands mean the same thing in every mode.
    const cushionRatio =
      cov.minCashReserve > 0 ? reserveRemaining / cov.minCashReserve : reserveRemaining > 0 ? 1 : 0
    if (cushionRatio >= 0.5) classification = 'Very Safe'
    else if (cushionRatio >= 0.25) classification = 'Comfortable'
    else if (cushionRatio >= 0.1) classification = 'Supported'
    else classification = 'Tight'
  }

  return {
    endingCash,
    lowestProjectedCash: lowest,
    lowestMonthKey,
    reserveFloor,
    reserveRemaining,
    daysOfCash,
    payrollCoverageMonths,
    vendorCoverageMonths,
    debtCoverageMonths,
    locRequired,
    locUtilizationAfter,
    reserveCompressed,
    classification,
    failures,
    tradeoffs,
  }
}

/* ------------------------------------------------------------------ */
/* The ladder                                                          */
/* ------------------------------------------------------------------ */

/** Recurring monthly rungs offered by default, smallest first. */
export const RECURRING_RUNGS = [250, 500, 1000, 1500, 2000, 2500, 3000]

/** One-time rungs offered by default, smallest first. */
export const ONE_TIME_RUNGS = [1000, 2500, 5000, 7500, 10000, 15000]

export type LadderRung = RungEvaluation & {
  kind: 'recurring' | 'one-time'
  amount: number
  isCustom: boolean
}

export function buildCapacityLadder(
  assumptions: ProjectionAssumptions,
  mode: RiskMode,
  cov: CoverageInputs,
  opts?: { customRecurring?: number | null; customOneTime?: number | null },
): LadderRung[] {
  const rungs: LadderRung[] = []

  const push = (kind: 'recurring' | 'one-time', amount: number, isCustom: boolean) => {
    const commitment: Commitment =
      kind === 'recurring'
        ? { recurringMonthly: amount, oneTime: 0 }
        : { recurringMonthly: 0, oneTime: amount }
    rungs.push({
      kind,
      amount,
      isCustom,
      ...evaluateRung(assumptions, commitment, mode, cov),
    })
  }

  for (const a of RECURRING_RUNGS) push('recurring', a, false)
  if (opts?.customRecurring != null && opts.customRecurring > 0) {
    push('recurring', opts.customRecurring, true)
  }
  for (const a of ONE_TIME_RUNGS) push('one-time', a, false)
  if (opts?.customOneTime != null && opts.customOneTime > 0) {
    push('one-time', opts.customOneTime, true)
  }

  return rungs
}

/**
 * Largest amount of a given kind that still clears every gate.
 *
 * Binary search rather than reusing the ladder, so the headline figure is exact
 * instead of being rounded down to whichever preset rung happened to pass.
 * Returns 0 when even a dollar fails, which is a real and important answer.
 */
export function maxSupported(
  assumptions: ProjectionAssumptions,
  mode: RiskMode,
  cov: CoverageInputs,
  kind: 'recurring' | 'one-time',
  opts?: { ceiling?: number; tolerance?: number },
): number {
  const tolerance = opts?.tolerance ?? 1
  const build = (amount: number): Commitment =>
    kind === 'recurring'
      ? { recurringMonthly: amount, oneTime: 0 }
      : { recurringMonthly: 0, oneTime: amount }

  const supported = (amount: number): boolean =>
    evaluateRung(assumptions, build(amount), mode, cov).classification !== 'Not Supported'

  if (!supported(tolerance)) return 0

  // Establish an upper bound that definitely fails before narrowing.
  let hi = opts?.ceiling ?? 1000
  let guard = 0
  while (supported(hi) && guard++ < 40) hi *= 2
  let lo = 0

  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2
    if (supported(mid)) lo = mid
    else hi = mid
  }

  return Math.floor(lo)
}

/* ------------------------------------------------------------------ */
/* Scenario matrix                                                     */
/* ------------------------------------------------------------------ */

export type ScenarioDefinition = {
  key: string
  label: string
  description: string
  inflowMultiplier: number
  outflowMultiplier: number
}

export const SCENARIOS: ScenarioDefinition[] = [
  {
    key: 'base',
    label: 'Base',
    description: 'Sales and costs continue at their recent averages.',
    inflowMultiplier: 1,
    outflowMultiplier: 1,
  },
  {
    key: 'sales_down_5',
    label: 'Sales down 5%',
    description: 'A mild slowdown in revenue with costs unchanged.',
    inflowMultiplier: 0.95,
    outflowMultiplier: 1,
  },
  {
    key: 'sales_down_10',
    label: 'Sales down 10%',
    description: 'A meaningful slowdown in revenue with costs unchanged.',
    inflowMultiplier: 0.9,
    outflowMultiplier: 1,
  },
  {
    key: 'sales_down_15',
    label: 'Sales down 15%',
    description: 'A severe slowdown in revenue with costs unchanged.',
    inflowMultiplier: 0.85,
    outflowMultiplier: 1,
  },
  {
    key: 'cost_overrun_10',
    label: 'Costs up 10%',
    description: 'Costs rise 10% while sales hold steady.',
    inflowMultiplier: 1,
    outflowMultiplier: 1.1,
  },
  {
    key: 'combined_stress',
    label: 'Combined stress',
    description: 'Sales down 10% and costs up 10% at the same time.',
    inflowMultiplier: 0.9,
    outflowMultiplier: 1.1,
  },
  {
    key: 'growth',
    label: 'Growth',
    description: 'Sales up 10% with a small rise in the cost of serving them.',
    inflowMultiplier: 1.1,
    outflowMultiplier: 1.02,
  },
]

export type ScenarioResult = ScenarioDefinition & RungEvaluation

/**
 * Run one commitment through every scenario.
 *
 * A custom sales-decline percentage can be appended so the owner can test the
 * drop they actually fear rather than only the presets.
 */
export function buildScenarioMatrix(
  assumptions: ProjectionAssumptions,
  commitment: Commitment,
  mode: RiskMode,
  cov: CoverageInputs,
  opts?: { customSalesDeclinePct?: number | null },
): ScenarioResult[] {
  const defs = [...SCENARIOS]

  const pct = opts?.customSalesDeclinePct
  if (pct != null && pct > 0 && pct < 100 && !defs.some((d) => d.inflowMultiplier === 1 - pct / 100)) {
    defs.push({
      key: `sales_down_custom_${pct}`,
      label: `Sales down ${pct}%`,
      description: `Your own stress test: revenue ${pct}% below the recent average.`,
      inflowMultiplier: 1 - pct / 100,
      outflowMultiplier: 1,
    })
  }

  return defs.map((d) => ({
    ...d,
    ...evaluateRung(
      {
        ...assumptions,
        inflowMultiplier: d.inflowMultiplier,
        outflowMultiplier: d.outflowMultiplier,
      },
      commitment,
      mode,
      cov,
    ),
  }))
}

/* ------------------------------------------------------------------ */
/* Strategy — deliberately separate from affordability                 */
/* ------------------------------------------------------------------ */

export type StrategicTiming = {
  /** 0–100. Attractiveness of the timing, NOT whether it is affordable. */
  score: number
  rating: 'Strong' | 'Reasonable' | 'Weak'
  /** Plain-language reason, safe to show beside the affordability verdict. */
  detail: string
  /** Months in the horizon that are seasonally below average. */
  weakMonths: string[]
}

/**
 * Judge WHEN to spend, never WHETHER it is affordable.
 *
 * Kept strictly separate on purpose: a seasonally slow stretch makes an investment
 * less attractive, but it does not make it unaffordable, and conflating the two
 * would either block safe spending or bless unsafe spending. Nothing here feeds
 * `evaluateRung`.
 */
export function assessStrategicTiming(input: {
  startMonthKey: string
  horizonMonths: number
  /** Seasonal index per month of the horizon, 1 = average. */
  seasonalIndex: number[]
  /** Revenue trend as a percentage, e.g. -4.2 for a 4.2% decline. */
  revenueTrendPct: number
}): StrategicTiming {
  const idx = input.seasonalIndex.slice(0, input.horizonMonths)
  const avg = idx.length > 0 ? idx.reduce((s, v) => s + v, 0) / idx.length : 1

  const weakMonths: string[] = []
  idx.forEach((v, i) => {
    if (v < 0.95) weakMonths.push(addMonths(input.startMonthKey, i))
  })

  // Seasonal strength contributes most; trend adjusts it.
  const seasonalScore = Math.max(0, Math.min(100, Math.round(avg * 100)))
  const trendAdj = Math.max(-20, Math.min(20, Math.round(input.revenueTrendPct)))
  const score = Math.max(0, Math.min(100, seasonalScore + trendAdj))

  const rating: StrategicTiming['rating'] =
    score >= 100 ? 'Strong' : score >= 85 ? 'Reasonable' : 'Weak'

  const parts: string[] = []
  parts.push(
    avg >= 1
      ? `The next ${idx.length} months run about ${Math.round((avg - 1) * 100)}% above an average month.`
      : `The next ${idx.length} months run about ${Math.round((1 - avg) * 100)}% below an average month.`,
  )
  if (input.revenueTrendPct !== 0) {
    parts.push(
      input.revenueTrendPct > 0
        ? `Revenue is trending up ${input.revenueTrendPct.toFixed(1)}%.`
        : `Revenue is trending down ${Math.abs(input.revenueTrendPct).toFixed(1)}%.`,
    )
  }
  parts.push('This affects timing only — affordability is judged separately.')

  return { score, rating, detail: parts.join(' '), weakMonths }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}
