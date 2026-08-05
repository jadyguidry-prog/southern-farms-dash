/**
 * Credit-card and credit-line safety, plus data-freshness judgement.
 *
 * Pure functions only — no database access — so the Growth Planner, the tests, and
 * any future surface all share one definition instead of re-deriving it. This is the
 * module that decides how much borrowing headroom is real, and how much to trust it.
 *
 * Two rules run through everything here:
 *
 *  1. Missing data is never zero. An untracked statement balance is `null`, not 0,
 *     because 0 would read as "card fully paid off" and quietly inflate safety.
 *  2. Stale data still answers, but says so. These figures are entered by hand, so a
 *     month-old balance is normal. Refusing to answer would make the planner useless;
 *     trusting it silently could make an unsafe commitment look safe. So the age is
 *     always reported and confidence is reduced instead.
 */

/**
 * Utilisation at or above which a card is called "highly used", as a FRACTION (0-1),
 * not a percentage.
 *
 * Exported so the advisor and any other surface reuse this exact number instead of
 * declaring a second, slightly different threshold. Two competing definitions of
 * "high utilisation" would let one surface warn while another stayed calm about the
 * same card.
 *
 * This was already the value used inline here before it was given a name; it is not a
 * new threshold invented for this business.
 */
export const HIGH_UTILIZATION_THRESHOLD = 0.8

// Account shape this module needs. Deliberately a structural subset of the row
// returned by `getBankAccounts()`, so callers pass their rows straight in.
export type CreditAccountInput = {
  id?: string
  accountName: string
  accountType: string
  /** For a credit account this is the amount OWED, not cash. */
  currentBalance: number
  creditLimit: number
  availableCredit: number
  /** Latest statement amount due. Null means not tracked — never treat as 0. */
  statementBalance?: number | null
  /** Date that statement must be paid by. Null means not tracked. */
  statementDueDate?: string | null
  /** First day of the billing cycle `statementBalance` covers. Null = not recorded. */
  statementPeriodStart?: string | null
  /**
   * Closing date of the billing cycle `statementBalance` covers. Null = not recorded.
   *
   * This is what makes a SUPERSEDED statement detectable. Without it, a balance left
   * over from a cycle that closed months ago is indistinguishable from this month's,
   * because `lastUpdated` only says when someone typed a number — not which cycle the
   * number belongs to.
   */
  statementPeriodEnd?: string | null
  /** ISO date the figures were last confirmed. Empty means never recorded. */
  lastUpdated?: string
}

/** Account types that represent revolving borrowing rather than cash. */
export const CREDIT_ACCOUNT_TYPES = ['Line of Credit', 'Credit Card'] as const
/** Cards specifically — they have statements and due dates; a line of credit may not. */
export const CARD_ACCOUNT_TYPE = 'Credit Card'

export function isCreditAccount(accountType: string): boolean {
  return (CREDIT_ACCOUNT_TYPES as readonly string[]).includes(accountType)
}

// ---------------------------------------------------------------------------
// Freshness

export type Freshness = {
  /** Whole days since the figure was confirmed. Null when never recorded. */
  ageDays: number | null
  /** True when never recorded at all — worse than merely old. */
  neverRecorded: boolean
  /** True when older than the configured threshold. */
  isStale: boolean
  /** Owner-facing phrase, e.g. "confirmed 34 days ago". */
  label: string
}

/**
 * How old is a hand-entered figure?
 *
 * `today` is injected rather than read from the clock so results are reproducible
 * and testable — a function that reads `new Date()` internally cannot be verified.
 */
export function accountFreshness(
  lastUpdated: string | undefined | null,
  today: Date,
  staleAfterDays: number,
): Freshness {
  const raw = (lastUpdated ?? '').trim()
  if (!raw) {
    return {
      ageDays: null,
      neverRecorded: true,
      // Never recorded is treated as stale: there is no evidence the figure was ever
      // true, which is strictly weaker than an old but once-confirmed number.
      isStale: true,
      label: 'never confirmed',
    }
  }

  const then = new Date(raw + 'T00:00:00')
  if (Number.isNaN(then.getTime())) {
    return {
      ageDays: null,
      neverRecorded: true,
      isStale: true,
      label: 'confirmation date unreadable',
    }
  }

  const midnightToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  )
  const ageDays = Math.floor(
    (midnightToday.getTime() - then.getTime()) / 86_400_000,
  )

  // A future date is not "fresh for longer" — it means someone mistyped, so it is
  // reported rather than silently accepted as extra-current.
  if (ageDays < 0) {
    return {
      ageDays,
      neverRecorded: false,
      isStale: true,
      label: `confirmation date is in the future (${raw})`,
    }
  }

  return {
    ageDays,
    neverRecorded: false,
    isStale: ageDays > staleAfterDays,
    label:
      ageDays === 0
        ? 'confirmed today'
        : ageDays === 1
          ? 'confirmed yesterday'
          : `confirmed ${ageDays} days ago`,
  }
}

// ---------------------------------------------------------------------------
// Statement cycle

export type StatementCycle = {
  start: string | null
  end: string | null
  /** True when neither end of the cycle is recorded. */
  notRecorded: boolean
  /** Whole days since the cycle closed. Null when the closing date is unknown. */
  daysSinceClose: number | null
  /**
   * True when the cycle closed long enough ago that a newer statement should exist,
   * so the recorded balance is probably last cycle's rather than the current one.
   */
  superseded: boolean
  /** Owner-facing phrase, e.g. "cycle 4 Jul - 3 Aug". */
  label: string
}

/**
 * Which billing cycle does the recorded statement balance belong to, and is it current?
 *
 * This exists because `lastUpdated` answers a different question. It records when a
 * figure was TYPED, not which cycle it COVERS — so a statement from a cycle that
 * closed in May, re-confirmed today, looks perfectly fresh while describing a period
 * three months gone.
 *
 * `today` is injected rather than read from the clock so results are reproducible.
 */
export function statementCycle(
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
  today: Date,
  cycleStaleAfterDays: number,
): StatementCycle {
  const start = (periodStart ?? '').trim() || null
  const end = (periodEnd ?? '').trim() || null

  if (!start && !end) {
    return {
      start: null,
      end: null,
      notRecorded: true,
      daysSinceClose: null,
      // Not recorded is NOT "superseded". Absent data and a known-stale cycle need
      // different remedies -- one asks the owner for the cycle dates, the other asks
      // for the newer statement -- so they must not collapse into one flag.
      superseded: false,
      label: 'statement cycle not recorded',
    }
  }

  const daysSinceClose = end ? -1 * (daysBetween(end, today) ?? 0) : null
  const closeReadable = end ? daysBetween(end, today) !== null : false

  return {
    start,
    end,
    notRecorded: false,
    daysSinceClose: closeReadable ? daysSinceClose : null,
    superseded:
      closeReadable && daysSinceClose !== null
        ? daysSinceClose > cycleStaleAfterDays
        : false,
    label: formatCycleLabel(start, end),
  }
}

function formatCycleLabel(start: string | null, end: string | null): string {
  const fmt = (iso: string): string => {
    const d = new Date(iso + 'T00:00:00')
    if (Number.isNaN(d.getTime())) return iso
    return `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })}`
  }
  if (start && end) return `cycle ${fmt(start)} - ${fmt(end)}`
  if (end) return `cycle closing ${fmt(end)}`
  return `cycle from ${fmt(start as string)}`
}

// ---------------------------------------------------------------------------
// Per-account and aggregate card safety

export type CardAssessment = {
  accountName: string
  accountType: string
  owed: number
  limit: number
  /**
   * Undrawn headroom. Taken from `availableCredit` when the row supplies a limit,
   * because that is the figure the owner actually confirmed. Null when the limit is
   * unknown, since headroom cannot be derived without it.
   */
  headroom: number | null
  /** Owed ÷ limit, 0–1. Null when the limit is unknown. */
  utilization: number | null
  statementBalance: number | null
  statementDueDate: string | null
  /** Days until the statement is due. Negative means overdue. Null when untracked. */
  daysUntilDue: number | null
  freshness: Freshness
  /** Which billing cycle the statement balance covers, and whether it is current. */
  cycle: StatementCycle
  /**
   * True when a statement balance is recorded AND its cycle is known to be current
   * (or, for a card with no balance owed, when there is nothing to time). This is the
   * flag a caller should check before treating `statementBalance` as this month's bill.
   */
  statementIsCurrent: boolean
  /** Specific, owner-readable problems found on this account. */
  warnings: string[]
}

export type CardSafetySummary = {
  cards: CardAssessment[]
  /** Total owed across credit accounts. */
  totalOwed: number
  /** Total approved limit across accounts that report one. */
  totalLimit: number
  /**
   * Total usable headroom. Counts only accounts with a known limit — an account
   * whose limit is unknown contributes nothing rather than an assumed amount.
   */
  totalHeadroom: number
  /** Weighted utilisation across accounts with known limits. Null when none do. */
  utilization: number | null
  /** True when at least one credit account exists. */
  hasCreditAccounts: boolean
  /** Accounts whose limit is unknown, so their headroom is unusable. */
  untrackedLimitCount: number
  /** Accounts whose figures are stale or never confirmed. */
  staleCount: number
  /**
   * Cards carrying a balance whose statement cannot be shown to be the current one —
   * either the cycle dates are missing or the cycle has been superseded.
   */
  uncertainStatementCount: number
  /** Aggregate problems worth surfacing above the per-card detail. */
  warnings: string[]
  /**
   * How much to trust this assessment.
   *  - 'high'    — every credit account has a known limit and fresh figures.
   *  - 'reduced' — figures exist but some are stale, or a limit is unknown.
   *  - 'missing' — no credit accounts are set up at all.
   */
  confidence: 'high' | 'reduced' | 'missing'
}

function daysBetween(fromISO: string, today: Date): number | null {
  const d = new Date(fromISO + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return null
  const midnightToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  )
  return Math.floor((d.getTime() - midnightToday.getTime()) / 86_400_000)
}

/**
 * Assess every credit account: what is owed, what headroom is genuinely usable, and
 * how much the numbers can be trusted.
 *
 * Deposit accounts are ignored — headroom parked on a savings row is not borrowing
 * capacity. That is exactly how an untaken loan OFFER once sat on Square Savings.
 */
export function assessCardSafety(
  accounts: CreditAccountInput[],
  today: Date,
  opts: { staleAfterDays: number; cycleStaleAfterDays: number },
): CardSafetySummary {
  const credit = accounts.filter((a) => isCreditAccount(a.accountType))

  const cards: CardAssessment[] = credit.map((a) => {
    const warnings: string[] = []
    const freshness = accountFreshness(a.lastUpdated, today, opts.staleAfterDays)

    const limitKnown = a.creditLimit > 0
    const headroom = limitKnown ? a.availableCredit : null
    const utilization = limitKnown ? a.currentBalance / a.creditLimit : null

    if (!limitKnown) {
      warnings.push(
        `${a.accountName}: credit limit not recorded, so its borrowing headroom is not counted.`,
      )
    }

    if (freshness.neverRecorded) {
      warnings.push(`${a.accountName}: balance has never been confirmed.`)
    } else if (freshness.isStale) {
      warnings.push(`${a.accountName}: balance ${freshness.label}.`)
    }

    // A card carrying a balance but with no statement tracked cannot be timed
    // against a due date, which is the whole point of capturing it.
    if (
      a.accountType === CARD_ACCOUNT_TYPE &&
      a.statementBalance === null &&
      a.currentBalance > 0
    ) {
      warnings.push(
        `${a.accountName}: statement balance not tracked, so payment timing can't be checked.`,
      )
    }

    const cycle = statementCycle(
      a.statementPeriodStart,
      a.statementPeriodEnd,
      today,
      opts.cycleStaleAfterDays,
    )

    // Only meaningful for a card that actually reports a statement.
    const hasStatement = (a.statementBalance ?? null) !== null
    if (a.accountType === CARD_ACCOUNT_TYPE && hasStatement) {
      if (cycle.notRecorded) {
        warnings.push(
          `${a.accountName}: statement cycle dates not recorded, so there is no way to tell whether this balance is the current statement.`,
        )
      } else if (cycle.superseded) {
        warnings.push(
          `${a.accountName}: recorded statement covers the ${cycle.label}, which closed ${cycle.daysSinceClose} days ago — a newer statement has almost certainly been issued.`,
        )
      }
    }

    const daysUntilDue = a.statementDueDate
      ? daysBetween(a.statementDueDate, today)
      : null

    if (daysUntilDue !== null && daysUntilDue < 0 && (a.statementBalance ?? 0) > 0) {
      warnings.push(
        `${a.accountName}: statement was due ${Math.abs(daysUntilDue)} days ago.`,
      )
    }

    // Utilisation above 80% is a real constraint: it limits further borrowing and
    // pressures the next statement, so it is surfaced rather than left implicit.
    if (utilization !== null && utilization >= HIGH_UTILIZATION_THRESHOLD) {
      warnings.push(
        `${a.accountName}: ${Math.round(utilization * 100)}% of its limit is already used.`,
      )
    }

    return {
      accountName: a.accountName,
      accountType: a.accountType,
      owed: a.currentBalance,
      limit: a.creditLimit,
      headroom,
      utilization,
      statementBalance: a.statementBalance ?? null,
      statementDueDate: a.statementDueDate ?? null,
      daysUntilDue,
      freshness,
      cycle,
      // Judges the RECORDED statement's cycle, and only that.
      //
      // A card with no statement recorded is NOT reported here as an uncertain cycle:
      // that gap already has its own warning ("statement balance not tracked"), and
      // counting it a second time as a cycle problem would report one missing figure
      // as two different defects and push confidence down twice for it. This flag
      // answers a narrower question -- "is the statement we DO have the current one?"
      // -- so a card with nothing recorded, and a card owing nothing at all, both
      // pass here and are handled by their own checks.
      statementIsCurrent: !hasStatement
        ? true
        : !cycle.notRecorded && !cycle.superseded,
      warnings,
    }
  })

  const totalOwed = cards.reduce((s, c) => s + c.owed, 0)
  const totalLimit = cards.reduce((s, c) => s + c.limit, 0)
  const totalHeadroom = cards.reduce((s, c) => s + (c.headroom ?? 0), 0)
  const untrackedLimitCount = cards.filter((c) => c.headroom === null).length
  const staleCount = cards.filter((c) => c.freshness.isStale).length
  const uncertainStatementCount = cards.filter(
    (c) => c.accountType === CARD_ACCOUNT_TYPE && !c.statementIsCurrent,
  ).length

  const warnings: string[] = []
  if (cards.length === 0) {
    warnings.push(
      'No credit cards or credit lines are set up, so card exposure cannot be judged.',
    )
  }

  const confidence: CardSafetySummary['confidence'] =
    cards.length === 0
      ? 'missing'
      : staleCount > 0 ||
          untrackedLimitCount > 0 ||
          // A statement that can't be shown to be current is exactly as unreliable as
          // a stale balance, so it must pull confidence down the same way. Otherwise a
          // superseded statement would be reported per-card while the summary still
          // claimed 'high'.
          uncertainStatementCount > 0
        ? 'reduced'
        : 'high'

  return {
    cards,
    totalOwed,
    totalLimit,
    totalHeadroom,
    utilization: totalLimit > 0 ? totalOwed / totalLimit : null,
    hasCreditAccounts: cards.length > 0,
    untrackedLimitCount,
    staleCount,
    uncertainStatementCount,
    warnings,
    confidence,
  }
}

// ---------------------------------------------------------------------------
// Timing a new commitment against card due dates

export type DueDateConflict = {
  accountName: string
  statementDueDate: string
  statementBalance: number
  /** Days between the commitment and the statement due date. */
  gapDays: number
  /**
   * False when the statement cannot be shown to cover the current cycle, so the
   * amount is the best available figure rather than a confirmed one. The conflict is
   * still reported — suppressing it would hide real exposure — but callers should
   * present the number as unconfirmed.
   */
  amountConfirmed: boolean
  message: string
}

/**
 * Would spending money on `commitmentDate` collide with a card statement coming due?
 *
 * The risk is ordinary: a commitment paid days before a large statement can leave
 * the statement short even though each looked affordable alone. Only statements with
 * a tracked balance greater than zero are considered — an untracked statement is
 * reported as missing data elsewhere, not guessed at here.
 */
export function findDueDateConflicts(
  summary: CardSafetySummary,
  commitmentDate: string,
  opts: { windowDays: number },
): DueDateConflict[] {
  const commitment = new Date(commitmentDate + 'T00:00:00')
  if (Number.isNaN(commitment.getTime())) return []

  const conflicts: DueDateConflict[] = []

  for (const c of summary.cards) {
    if (!c.statementDueDate) continue
    const bal = c.statementBalance
    if (bal === null || bal <= 0) continue

    const due = new Date(c.statementDueDate + 'T00:00:00')
    if (Number.isNaN(due.getTime())) continue

    const gapDays = Math.floor(
      (due.getTime() - commitment.getTime()) / 86_400_000,
    )

    // Only a statement due ON or AFTER the commitment is a conflict: one already
    // paid before the commitment date competes for nothing.
    if (gapDays < 0 || gapDays > opts.windowDays) continue

    const money = bal.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
    })
    const timing =
      gapDays === 0 ? 'is due the same day' : `is due ${gapDays} day${gapDays === 1 ? '' : 's'} later`

    // A superseded or undated cycle means this figure may not be the bill that is
    // actually coming. Say so in the message rather than presenting it as fact.
    const caveat = c.statementIsCurrent
      ? ''
      : c.cycle.superseded
        ? ` (from the ${c.cycle.label}, which has since closed — confirm the current statement)`
        : ' (statement cycle not recorded — amount unconfirmed)'

    conflicts.push({
      accountName: c.accountName,
      statementDueDate: c.statementDueDate,
      statementBalance: bal,
      gapDays,
      amountConfirmed: c.statementIsCurrent,
      message: `${c.accountName} statement of ${money} ${timing}${caveat}.`,
    })
  }

  // Soonest first — the tightest squeeze matters most.
  return conflicts.sort((a, b) => a.gapDays - b.gapDays)
}
