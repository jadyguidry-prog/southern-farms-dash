/**
 * Growth proposals — typed investment proposals and their decision output.
 *
 * Pure functions only: no database, no AI, no clock reads. A proposal is turned
 * into the SAME `Commitment` shape the capacity ladder already judges, then run
 * through the SAME `evaluateRung` / `buildScenarioMatrix`. This layer adds no new
 * money math of its own — it only (a) translates type-specific inputs into a
 * commitment, and (b) composes the engine's output into a decision the owner can
 * act on. That keeps proposals and the ladder answering with one voice.
 *
 * Two deliberate honesty rules, both chosen by the owner:
 *   - EMPLOYEE COST IS NEVER "just the wage". Employer burden (payroll taxes,
 *     workers' comp, unemployment) is entered per proposal and added on top. A
 *     hire that looks affordable at the wage can be unaffordable once burden is
 *     counted, and hiding that would be the most expensive kind of wrong.
 *   - ROI IS REVENUE-BASED. This business has no gross-margin figure we trust, so
 *     we never quote a profit ROI as if we did. We state the additional GROSS
 *     PROFIT the investment must produce to break even (which equals its cost),
 *     and — only as clearly-labelled sensitivity — what that implies in SALES at
 *     a few assumed margins. We never pick a margin and present it as fact.
 */

import {
  type Classification,
  type Commitment,
  type CoverageInputs,
  type ProjectionAssumptions,
  type RiskMode,
  type RungEvaluation,
  type ScenarioResult,
  type StrategicTiming,
  buildScenarioMatrix,
  evaluateRung,
} from '@/lib/growth-planner'

/* ------------------------------------------------------------------ */
/* Proposal inputs                                                     */
/* ------------------------------------------------------------------ */

export type ProposalType =
  | 'marketing_agency'
  | 'marketing_campaign'
  | 'equipment'
  | 'employee_hire'
  | 'inventory'

export const PROPOSAL_TYPE_LABELS: Record<ProposalType, string> = {
  marketing_agency: 'Marketing agency / retainer',
  marketing_campaign: 'Marketing campaign / ad spend',
  equipment: 'Equipment purchase',
  employee_hire: 'Employee hire',
  inventory: 'Inventory / one-time buy',
}

/** How an equipment purchase is paid for — changes what hits cash and when. */
export type EquipmentFinancing =
  | 'cash'
  | 'down_and_finance'
  | 'full_finance'
  | 'card'
  | 'lease'

export const EQUIPMENT_FINANCING_LABELS: Record<EquipmentFinancing, string> = {
  cash: 'Pay cash in full',
  down_and_finance: 'Down payment, finance the rest',
  full_finance: 'Finance the whole amount',
  card: 'Put it on a credit card',
  lease: 'Lease it',
}

export type MarketingAgencyProposal = {
  type: 'marketing_agency'
  name: string
  /** Recurring retainer charged every month. */
  monthlyRetainer: number
  /** One-off setup / onboarding fee, if any. */
  setupFee?: number
}

export type MarketingCampaignProposal = {
  type: 'marketing_campaign'
  name: string
  /** Added ad spend per month. */
  monthlyAmount: number
  /**
   * How many months the campaign runs. A fixed, short campaign is a bounded
   * commitment, not a forever cost, and the decision output says so. Omitted or 0
   * means ongoing.
   */
  durationMonths?: number
}

export type EquipmentProposal = {
  type: 'equipment'
  name: string
  price: number
  financing: EquipmentFinancing
  /** Down payment for `down_and_finance`. */
  downPayment?: number
  /** Monthly payment for financed / leased structures. */
  monthlyPayment?: number
  /** Term in months for financed / leased structures. */
  termMonths?: number
  /** Lump sum owed at the end of a lease/finance term, if any. */
  balloonPayment?: number
}

export type EmployeeHireProposal = {
  type: 'employee_hire'
  name: string
  /** Either hourly + hours, or an annual salary. */
  hourlyWage?: number
  hoursPerWeek?: number
  annualSalary?: number
  /**
   * Employer burden as a PERCENT on top of base pay — payroll taxes, workers'
   * comp, unemployment. Entered per proposal on purpose: it varies by role and
   * state, and no single stored rate would be honest for every hire.
   */
  employerBurdenPct: number
  /** One-off onboarding / equipment cost for the new hire, if any. */
  oneTimeSetup?: number
}

export type InventoryProposal = {
  type: 'inventory'
  name: string
  /** One-time purchase amount. */
  amount: number
}

export type Proposal =
  | MarketingAgencyProposal
  | MarketingCampaignProposal
  | EquipmentProposal
  | EmployeeHireProposal
  | InventoryProposal

/* ------------------------------------------------------------------ */
/* Cost translation                                                    */
/* ------------------------------------------------------------------ */

export type CostLine = {
  label: string
  amount: number
  cadence: 'monthly' | 'one-time'
  /** Optional plain-language caveat shown beside the line. */
  note?: string
}

export type ProposalCost = {
  commitment: Commitment
  lines: CostLine[]
  /** Anything true about the cost that the commitment alone cannot express. */
  caveats: string[]
}

const WEEKS_PER_MONTH = 52 / 12

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Translate a typed proposal into a cash commitment plus an itemised breakdown.
 *
 * The breakdown exists so the owner sees WHY the monthly/upfront numbers are what
 * they are — especially employer burden, which is the line most often forgotten.
 */
export function proposalToCost(p: Proposal): ProposalCost {
  const lines: CostLine[] = []
  const caveats: string[] = []
  let recurringMonthly = 0
  let oneTime = 0

  switch (p.type) {
    case 'marketing_agency': {
      recurringMonthly = Math.max(0, p.monthlyRetainer)
      lines.push({ label: 'Monthly retainer', amount: recurringMonthly, cadence: 'monthly' })
      if (p.setupFee && p.setupFee > 0) {
        oneTime = p.setupFee
        lines.push({ label: 'Setup fee', amount: p.setupFee, cadence: 'one-time' })
      }
      break
    }

    case 'marketing_campaign': {
      recurringMonthly = Math.max(0, p.monthlyAmount)
      const dur = p.durationMonths && p.durationMonths > 0 ? p.durationMonths : null
      lines.push({
        label: 'Monthly ad spend',
        amount: recurringMonthly,
        cadence: 'monthly',
        note: dur ? `Runs ${dur} month${dur === 1 ? '' : 's'}.` : 'Ongoing.',
      })
      if (dur) {
        // Judged as a recurring cost across the horizon deliberately: the projection
        // must survive the campaign WHILE it runs. Treating a 3-month campaign as
        // 1/3 the monthly cost would understate the squeeze in exactly those months.
        caveats.push(
          `This is a bounded ${dur}-month campaign, not a permanent cost, but it is judged as recurring so the plan survives every month it is actually running.`,
        )
      }
      break
    }

    case 'equipment': {
      switch (p.financing) {
        case 'cash': {
          oneTime = Math.max(0, p.price)
          lines.push({ label: 'Purchase price (cash)', amount: oneTime, cadence: 'one-time' })
          break
        }
        case 'down_and_finance': {
          oneTime = Math.max(0, p.downPayment ?? 0)
          recurringMonthly = Math.max(0, p.monthlyPayment ?? 0)
          lines.push({ label: 'Down payment', amount: oneTime, cadence: 'one-time' })
          lines.push({
            label: 'Monthly finance payment',
            amount: recurringMonthly,
            cadence: 'monthly',
            note: p.termMonths ? `${p.termMonths}-month term.` : undefined,
          })
          break
        }
        case 'full_finance': {
          recurringMonthly = Math.max(0, p.monthlyPayment ?? 0)
          lines.push({
            label: 'Monthly finance payment',
            amount: recurringMonthly,
            cadence: 'monthly',
            note: p.termMonths ? `${p.termMonths}-month term.` : undefined,
          })
          break
        }
        case 'lease': {
          recurringMonthly = Math.max(0, p.monthlyPayment ?? 0)
          lines.push({
            label: 'Monthly lease payment',
            amount: recurringMonthly,
            cadence: 'monthly',
            note: p.termMonths ? `${p.termMonths}-month lease.` : undefined,
          })
          break
        }
        case 'card': {
          // Honesty: a card purchase does not leave cash today, it lands on the next
          // statement. We treat the price as a one-time CASH cost because it must be
          // paid from cash when the statement comes due, and flag the timing so it is
          // not mistaken for free float.
          oneTime = Math.max(0, p.price)
          lines.push({
            label: 'Charged to card',
            amount: oneTime,
            cadence: 'one-time',
            note: 'Counted as cash owed — it must be paid off at the next statement.',
          })
          caveats.push(
            'On a card this raises card utilisation now and must be cleared at the next statement; it is not interest-free float unless you pay it in full.',
          )
          break
        }
      }
      if (p.balloonPayment && p.balloonPayment > 0) {
        caveats.push(
          `A ${money(p.balloonPayment)} balloon payment falls due at the end of the term — plan for it separately; it is not spread into the monthly figure.`,
        )
      }
      break
    }

    case 'employee_hire': {
      const base = employeeBasePay(p)
      const burden = round2(base * (Math.max(0, p.employerBurdenPct) / 100))
      recurringMonthly = round2(base + burden)
      lines.push({ label: 'Base pay', amount: round2(base), cadence: 'monthly' })
      lines.push({
        label: `Employer burden (${p.employerBurdenPct}%)`,
        amount: burden,
        cadence: 'monthly',
        note: 'Payroll taxes, workers’ comp, unemployment — real cost on top of the wage.',
      })
      if (p.oneTimeSetup && p.oneTimeSetup > 0) {
        oneTime = p.oneTimeSetup
        lines.push({ label: 'Onboarding / equipment', amount: p.oneTimeSetup, cadence: 'one-time' })
      }
      caveats.push(
        'The true cost of a hire is pay plus employer burden, not the wage alone. This figure includes burden.',
      )
      break
    }

    case 'inventory': {
      oneTime = Math.max(0, p.amount)
      lines.push({ label: 'Inventory purchase', amount: oneTime, cadence: 'one-time' })
      break
    }
  }

  return {
    commitment: { recurringMonthly: round2(recurringMonthly), oneTime: round2(oneTime) },
    lines,
    caveats,
  }
}

/** Monthly base pay from either hourly+hours or an annual salary. */
function employeeBasePay(p: EmployeeHireProposal): number {
  if (p.annualSalary && p.annualSalary > 0) return p.annualSalary / 12
  const wage = p.hourlyWage ?? 0
  const hours = p.hoursPerWeek ?? 0
  return wage * hours * WEEKS_PER_MONTH
}

/* ------------------------------------------------------------------ */
/* Downturn resilience                                                 */
/* ------------------------------------------------------------------ */

/**
 * Largest sales decline (percent) the commitment still survives — i.e. stays out
 * of 'Not Supported'. Binary search so the answer is exact rather than pinned to
 * whichever preset scenario happened to be tested. Returns 0 when even today's
 * numbers do not support it, and 100 when it survives a total revenue wipeout
 * (rare, but a real answer).
 */
export function maxSurvivableSalesDeclinePct(
  assumptions: ProjectionAssumptions,
  commitment: Commitment,
  mode: RiskMode,
  cov: CoverageInputs,
): number {
  const survives = (declinePct: number): boolean =>
    evaluateRung(
      { ...assumptions, inflowMultiplier: (assumptions.inflowMultiplier ?? 1) * (1 - declinePct / 100) },
      commitment,
      mode,
      cov,
    ).classification !== 'Not Supported'

  if (!survives(0)) return 0
  if (survives(100)) return 100

  let lo = 0
  let hi = 100
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2
    if (survives(mid)) lo = mid
    else hi = mid
  }
  return Math.floor(lo)
}

/* ------------------------------------------------------------------ */
/* Revenue-based ROI                                                   */
/* ------------------------------------------------------------------ */

export type RoiSensitivityRow = { marginPct: number; requiredMonthlySales: number }

export type RevenueRoi = {
  /**
   * Additional GROSS PROFIT per month the investment must generate to break even.
   * Equals its monthly cost — stated in profit, not sales, because we do not have
   * a margin we trust.
   */
  breakevenMonthlyGrossProfit: number
  /** One-time cost to recover, if any. */
  upfrontToRecover: number
  /**
   * What the break-even implies in SALES at a few ASSUMED margins. Explicitly a
   * sensitivity table, never a claim: we do not know this business's margin, so we
   * show a range instead of inventing one number.
   */
  sensitivity: RoiSensitivityRow[]
  /** Owner-supplied margin, if they chose to enter one. Labelled an assumption. */
  assumedMarginPct: number | null
  /** Required monthly sales at the assumed margin, when one was supplied. */
  requiredMonthlySalesAtAssumed: number | null
}

const DEFAULT_MARGIN_SENSITIVITY = [20, 30, 40, 50]

export function computeRevenueRoi(
  cost: ProposalCost,
  opts?: { assumedMarginPct?: number | null; margins?: number[] },
): RevenueRoi {
  const monthly = cost.commitment.recurringMonthly
  const upfront = cost.commitment.oneTime
  const margins = opts?.margins ?? DEFAULT_MARGIN_SENSITIVITY

  const sensitivity: RoiSensitivityRow[] = margins
    .filter((m) => m > 0 && m <= 100)
    .map((m) => ({ marginPct: m, requiredMonthlySales: round2(monthly / (m / 100)) }))

  const assumed = opts?.assumedMarginPct ?? null
  const requiredAtAssumed =
    assumed != null && assumed > 0 && assumed <= 100 ? round2(monthly / (assumed / 100)) : null

  return {
    breakevenMonthlyGrossProfit: monthly,
    upfrontToRecover: upfront,
    sensitivity,
    assumedMarginPct: assumed,
    requiredMonthlySalesAtAssumed: requiredAtAssumed,
  }
}

/* ------------------------------------------------------------------ */
/* Alternatives — "what has to change"                                 */
/* ------------------------------------------------------------------ */

export type Alternative = {
  kind: 'increase_cash' | 'reduce_recurring' | 'reduce_upfront' | 'delay' | 'resolve_data'
  label: string
  detail: string
}

/**
 * Concrete, computed changes that would make an unsupported proposal work — never
 * vague advice. Each one is derived from the actual shortfall, so "increase cash
 * by $X" uses the real X, and "reduce to N hours" solves for the N that fits.
 */
export function buildAlternatives(input: {
  proposal: Proposal
  cost: ProposalCost
  evaluation: RungEvaluation
  assumptions: ProjectionAssumptions
  mode: RiskMode
  cov: CoverageInputs
  strategy: StrategicTiming
  confidenceGaps: string[]
}): Alternative[] {
  const { proposal, cost, evaluation, assumptions, mode, cov, strategy, confidenceGaps } = input
  const out: Alternative[] = []

  if (evaluation.classification !== 'Not Supported') return out

  const shortfall = evaluation.reserveRemaining < 0 ? Math.abs(evaluation.reserveRemaining) : 0

  // 1. Increase cash by the exact shortfall.
  if (shortfall > 0) {
    out.push({
      kind: 'increase_cash',
      label: `Add about ${money(shortfall)} in cash first`,
      detail: `The plan dips ${money(shortfall)} below your reserve floor at its low point. Roughly that much more cash on hand — collected receivables, a transfer in — would clear it.`,
    })
  }

  // 2. Reduce the recurring cost to what fits (solve, don't guess).
  if (cost.commitment.recurringMonthly > 0) {
    const fits = largestFittingRecurring(cost.commitment.oneTime, assumptions, mode, cov)
    if (fits < cost.commitment.recurringMonthly) {
      out.push(reduceRecurringAlternative(proposal, cost, fits))
    }
  }

  // 3. Reduce the upfront cost to what fits.
  if (cost.commitment.oneTime > 0) {
    const fits = largestFittingOneTime(cost.commitment.recurringMonthly, assumptions, mode, cov)
    if (fits < cost.commitment.oneTime) {
      out.push({
        kind: 'reduce_upfront',
        label: `Keep the upfront cost at or under ${money(fits)}`,
        detail:
          proposal.type === 'equipment'
            ? `A larger down payment is the wrong direction here — it is the upfront hit that breaks the floor. Financing more (a smaller ${money(cost.commitment.oneTime)} down) or a cheaper unit under ${money(fits)} up front would fit.`
            : `An upfront cost of ${money(fits)} or less fits; ${money(cost.commitment.oneTime)} does not.`,
      })
    }
  }

  // 4. Delay to a seasonally stronger month.
  if (strategy.weakMonths.length > 0) {
    out.push({
      kind: 'delay',
      label: 'Wait for a stronger month',
      detail: `The next few months include seasonally slow stretches (${strategy.weakMonths.slice(0, 3).join(', ')}). Starting after them gives the plan more room — timing does not change affordability by itself, but it changes the low point this lands on.`,
    })
  }

  // 5. Resolve a data gap that is dragging confidence (e.g. missing card balance).
  const cardGap = confidenceGaps.find((g) => /card|balance|statement|amex/i.test(g))
  if (cardGap) {
    out.push({
      kind: 'resolve_data',
      label: 'Fill the missing card balance',
      detail:
        'Some card data is missing or stale, which lowers confidence in this answer. Entering the current balance would not just raise confidence — it could change the answer, since unknown card debt is real money owed.',
    })
  }

  return out
}

/** Largest recurring amount that fits alongside a fixed one-time cost. */
function largestFittingRecurring(
  oneTime: number,
  assumptions: ProjectionAssumptions,
  mode: RiskMode,
  cov: CoverageInputs,
): number {
  const supported = (r: number): boolean =>
    evaluateRung(assumptions, { recurringMonthly: r, oneTime }, mode, cov).classification !==
    'Not Supported'
  if (!supported(0)) return 0
  let lo = 0
  let hi = 1000
  let guard = 0
  while (supported(hi) && guard++ < 40) hi *= 2
  while (hi - lo > 1) {
    const mid = (lo + hi) / 2
    if (supported(mid)) lo = mid
    else hi = mid
  }
  return Math.floor(lo)
}

/** Largest one-time amount that fits alongside a fixed recurring cost. */
function largestFittingOneTime(
  recurring: number,
  assumptions: ProjectionAssumptions,
  mode: RiskMode,
  cov: CoverageInputs,
): number {
  const supported = (o: number): boolean =>
    evaluateRung(assumptions, { recurringMonthly: recurring, oneTime: o }, mode, cov)
      .classification !== 'Not Supported'
  if (!supported(0)) return 0
  let lo = 0
  let hi = 1000
  let guard = 0
  while (supported(hi) && guard++ < 40) hi *= 2
  while (hi - lo > 1) {
    const mid = (lo + hi) / 2
    if (supported(mid)) lo = mid
    else hi = mid
  }
  return Math.floor(lo)
}

/** Type-aware "reduce the recurring cost" alternative. */
function reduceRecurringAlternative(
  proposal: Proposal,
  cost: ProposalCost,
  fits: number,
): Alternative {
  if (proposal.type === 'employee_hire' && proposal.hourlyWage && proposal.hoursPerWeek) {
    // Solve the hours that land the burdened monthly cost at `fits`.
    const perHourMonthly =
      proposal.hourlyWage * WEEKS_PER_MONTH * (1 + Math.max(0, proposal.employerBurdenPct) / 100)
    const hours = perHourMonthly > 0 ? Math.floor(fits / perHourMonthly) : 0
    return {
      kind: 'reduce_recurring',
      label: `Hire for about ${hours} hours/week instead of ${proposal.hoursPerWeek}`,
      detail: `At ${money(proposal.hourlyWage)}/hr with ${proposal.employerBurdenPct}% burden, roughly ${hours} hours a week keeps the fully-loaded cost near ${money(fits)}/mo, which fits. The full ${proposal.hoursPerWeek} hours does not.`,
    }
  }
  return {
    kind: 'reduce_recurring',
    label: `Keep the monthly cost at or under ${money(fits)}`,
    detail: `A recurring cost of ${money(fits)}/mo or less fits; the proposed ${money(cost.commitment.recurringMonthly)}/mo does not.`,
  }
}

/* ------------------------------------------------------------------ */
/* Decision output — the 15 fields                                     */
/* ------------------------------------------------------------------ */

export type Verdict = 'Supported' | 'Supported with conditions' | 'Not supported'

export type ProposalDecision = {
  // 1-3: headline
  proposalName: string
  proposalType: ProposalType
  verdict: Verdict
  classification: Classification
  summary: string
  // 4-7: cost
  monthlyCost: number
  upfrontCost: number
  firstYearCost: number
  costLines: CostLine[]
  costCaveats: string[]
  // 8-10: cash impact
  lowestProjectedCash: number
  lowestMonthKey: string
  reserveRemaining: number
  daysOfCashAtLow: number
  // 11: resilience
  survivesSalesDeclinePct: number
  requiredResiliencePct: number
  // 12: what limits it
  bindingConstraint: string | null
  tradeoffs: string[]
  // 13: revenue-based ROI
  roi: RevenueRoi
  // 14-16: governance
  conditions: string[]
  monitoringPlan: string[]
  nextReviewDate: string
  // 17: fallbacks
  alternatives: Alternative[]
}

/**
 * Compose a full decision from a proposal and the live snapshot inputs.
 *
 * `todayISO` is passed in rather than read from the clock so this stays pure and
 * the verify script exercises the exact same code the page renders.
 */
export function analyzeProposal(input: {
  proposal: Proposal
  assumptions: ProjectionAssumptions
  mode: RiskMode
  cov: CoverageInputs
  strategy: StrategicTiming
  confidenceGaps: string[]
  todayISO: string
  reviewCadenceMonths: number
  assumedMarginPct?: number | null
  customSalesDeclinePct?: number | null
}): {
  decision: ProposalDecision
  evaluation: RungEvaluation
  scenarios: ScenarioResult[]
} {
  const {
    proposal,
    assumptions,
    mode,
    cov,
    strategy,
    confidenceGaps,
    todayISO,
    reviewCadenceMonths,
  } = input

  const cost = proposalToCost(proposal)
  const evaluation = evaluateRung(assumptions, cost.commitment, mode, cov)
  const scenarios = buildScenarioMatrix(assumptions, cost.commitment, mode, cov, {
    customSalesDeclinePct: input.customSalesDeclinePct ?? null,
  })

  const survives = maxSurvivableSalesDeclinePct(assumptions, cost.commitment, mode, cov)
  const roi = computeRevenueRoi(cost, { assumedMarginPct: input.assumedMarginPct ?? null })
  const alternatives = buildAlternatives({
    proposal,
    cost,
    evaluation,
    assumptions,
    mode,
    cov,
    strategy,
    confidenceGaps,
  })

  const verdict = deriveVerdict(evaluation, survives, mode)
  const conditions = buildConditions(proposal, cost, evaluation, survives, mode)
  const monitoringPlan = buildMonitoringPlan(proposal, cost, roi)

  const monthlyCost = cost.commitment.recurringMonthly
  const upfrontCost = cost.commitment.oneTime
  const firstYearCost = round2(upfrontCost + monthlyCost * 12)

  return {
    decision: {
      proposalName: proposal.name,
      proposalType: proposal.type,
      verdict,
      classification: evaluation.classification,
      summary: buildSummary(proposal, verdict, evaluation, survives, cost),
      monthlyCost,
      upfrontCost,
      firstYearCost,
      costLines: cost.lines,
      costCaveats: cost.caveats,
      lowestProjectedCash: evaluation.lowestProjectedCash,
      lowestMonthKey: evaluation.lowestMonthKey,
      reserveRemaining: evaluation.reserveRemaining,
      daysOfCashAtLow: Math.round(evaluation.daysOfCash),
      survivesSalesDeclinePct: survives,
      requiredResiliencePct: mode.headlineStressSalesDeclinePct,
      bindingConstraint: evaluation.failures[0] ?? null,
      tradeoffs: evaluation.tradeoffs,
      roi,
      conditions,
      monitoringPlan,
      nextReviewDate: addMonthsISO(todayISO, reviewCadenceMonths),
      alternatives,
    },
    evaluation,
    scenarios,
  }
}

function deriveVerdict(
  evaluation: RungEvaluation,
  survives: number,
  mode: RiskMode,
): Verdict {
  if (evaluation.classification === 'Not Supported') return 'Not supported'
  // Supported on today's numbers, but if it does not clear the mode's required
  // downturn, or it leans on tradeoffs, it is conditional rather than a clean yes.
  if (survives < mode.headlineStressSalesDeclinePct || evaluation.tradeoffs.length > 0) {
    return 'Supported with conditions'
  }
  return 'Supported'
}

function buildSummary(
  proposal: Proposal,
  verdict: Verdict,
  evaluation: RungEvaluation,
  survives: number,
  cost: ProposalCost,
): string {
  const costPhrase = costPhraseOf(cost)
  if (verdict === 'Not supported') {
    return `${proposal.name} (${costPhrase}) does not fit right now: ${evaluation.failures[0] ?? 'it crosses a limit you set.'} See what would have to change below.`
  }
  if (verdict === 'Supported with conditions') {
    return `${proposal.name} (${costPhrase}) fits on your expected numbers and holds up to about a ${survives}% sales drop, but it comes with conditions worth reading before you commit.`
  }
  return `${proposal.name} (${costPhrase}) fits comfortably and still holds up to about a ${survives}% sales drop. Your low point stays ${money(evaluation.reserveRemaining)} above your reserve floor.`
}

function costPhraseOf(cost: ProposalCost): string {
  const { recurringMonthly, oneTime } = cost.commitment
  const parts: string[] = []
  if (recurringMonthly > 0) parts.push(`${money(recurringMonthly)}/mo`)
  if (oneTime > 0) parts.push(`${money(oneTime)} upfront`)
  return parts.length > 0 ? parts.join(' + ') : 'no cost'
}

function buildConditions(
  proposal: Proposal,
  cost: ProposalCost,
  evaluation: RungEvaluation,
  survives: number,
  mode: RiskMode,
): string[] {
  const conditions: string[] = []

  if (survives <= 0) {
    // Distinct from the "thin headroom" case below: a survivable drop of 0 means
    // the proposal fails at today's numbers, so framing it as a tolerable-decline
    // threshold ("won't fall more than 0%") would misrepresent a plain no as a
    // near-miss.
    conditions.push(
      `This doesn't fit even at today's sales — it isn't a matter of avoiding a downturn. ${mode.label} wants ${mode.headlineStressSalesDeclinePct}% of headroom on top of that. See what would have to change below.`,
    )
  } else if (survives < mode.headlineStressSalesDeclinePct) {
    conditions.push(
      `Only proceed if you are confident sales won't fall more than about ${survives}% — below that this stops fitting, and ${mode.label} normally wants ${mode.headlineStressSalesDeclinePct}% of headroom.`,
    )
  }
  for (const t of evaluation.tradeoffs) conditions.push(t)
  for (const c of cost.caveats) conditions.push(c)

  if (proposal.type === 'employee_hire') {
    conditions.push(
      'Confirm the employer burden percent against a recent payroll run before committing — if it is higher than entered, the real monthly cost is higher too.',
    )
  }
  if (proposal.type === 'marketing_campaign' || proposal.type === 'marketing_agency') {
    conditions.push(
      'Agree in advance how you will attribute new sales to this spend, or you will not be able to tell whether it paid off.',
    )
  }
  return conditions
}

function buildMonitoringPlan(proposal: Proposal, cost: ProposalCost, roi: RevenueRoi): string[] {
  const plan: string[] = [
    `Watch that this generates at least ${money(roi.breakevenMonthlyGrossProfit)}/mo in additional gross profit — that is the break-even, in profit not sales.`,
    'Re-check cash on hand against the projected low point once real numbers start landing.',
  ]
  if (proposal.type === 'employee_hire') {
    plan.push('Track sales-per-labor-hour so you can see whether the added hours are paying for themselves.')
  }
  if (proposal.type === 'equipment') {
    plan.push('Track the payment against the projected break-even, and diarise any balloon payment separately.')
  }
  if (proposal.type === 'marketing_agency' || proposal.type === 'marketing_campaign') {
    plan.push('Track attributed sales monthly; pause the spend if it is not clearing break-even after a fair trial.')
  }
  return plan
}

/* ------------------------------------------------------------------ */
/* Date + money helpers                                                */
/* ------------------------------------------------------------------ */

/** Add whole months to a `YYYY-MM-DD` date, clamping the day to month length. */
export function addMonthsISO(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  const base = new Date(Date.UTC(y, m - 1, d))
  const targetMonth = base.getUTCMonth() + months
  const target = new Date(Date.UTC(base.getUTCFullYear(), targetMonth, 1))
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate()
  target.setUTCDate(Math.min(d, daysInTarget))
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(target.getUTCDate()).padStart(2, '0')
  return `${target.getUTCFullYear()}-${mm}-${dd}`
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}
