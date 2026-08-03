/**
 * Credit-card activity read from the TRANSACTION LEDGER, and the honest
 * reconciliation between that history and the balance the owner has confirmed.
 *
 * Pure functions only — no database access, no clock reads — so the dashboard, the
 * advisor, the report and the tests all share one definition. `today` is always
 * injected; a function that reads `new Date()` internally cannot be verified.
 *
 * WHY THIS EXISTS SEPARATELY FROM `card-safety.ts`
 * `card-safety.ts` judges the ACCOUNT ROW: what is owed, what headroom is real, how
 * old the hand-entered figure is. It cannot see the ledger, so it cannot tell that
 * card spending stopped being imported a month ago. That blind spot is exactly how a
 * large, real expense went untracked here: the card had 339 recorded transactions
 * and then simply stopped, and nothing was watching the gap grow.
 *
 * THE RULE THAT SHAPES EVERYTHING BELOW
 * A balance derived by adding up recorded transactions is only true if the card
 * started at zero when that history begins. Here that is NOT confirmed — the active
 * card's ledger starts 2026-01-06, immediately after a DIFFERENT card (ending
 * 0-72001) stopped on 2025-12-27, which is what a card replacement looks like, and a
 * replacement can carry a balance across. So the derived figure is published as a
 * labelled CROSS-CHECK with its assumption stated, never as "what you owe". The
 * owner-entered balance is the only anchor.
 */

import { monthKeyOf, monthsBetween } from './month-key'
import { formatCurrency } from './data'

/**
 * The ONE place a possibly-unrecorded card amount becomes display text.
 *
 * Shared by every surface on purpose. Amex runs thousands a month here, so a literal
 * "$0.00" for an amount nobody has entered reads as "paid off" and understates real
 * exposure to nothing. Null means "not recorded" and must always say so in words.
 * Keeping this in one exported function stops a future surface from quietly
 * reintroducing `?? 0`.
 */
export function formatOwedAmount(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Not recorded' : formatCurrency(value)
}

/**
 * One ledger row. A structural subset of `financial_transactions` so callers can
 * pass their rows straight in.
 *
 * `amount` is a POSITIVE MAGNITUDE in this database — direction lives in
 * `transactionType`, not in the sign. Verified against the live table: every card
 * row across all three types is positive.
 */
export type CardLedgerRow = {
  accountName: string
  /** ISO `YYYY-MM-DD`. */
  transactionDate: string
  transactionType: string
  amount: number
}

/** Ledger types that INCREASE the amount owed on a card. */
export const CARD_CHARGE_TYPES = ['expense', 'fee'] as const
/** Ledger types that REDUCE the amount owed on a card. */
export const CARD_CREDIT_TYPES = ['payment', 'refund'] as const

function normalizeType(t: string): string {
  return (t ?? '').trim().toLowerCase()
}

function isCharge(t: string): boolean {
  return (CARD_CHARGE_TYPES as readonly string[]).includes(normalizeType(t))
}

function isCredit(t: string): boolean {
  return (CARD_CREDIT_TYPES as readonly string[]).includes(normalizeType(t))
}

export type CardMonth = {
  /** `YYYY-MM`. */
  monthKey: string
  charges: number
  payments: number
  refunds: number
  txnCount: number
}

/**
 * Typical monthly charge volume across recorded months, used to size how much money a
 * stale feed is hiding. Null when there is no usable month.
 *
 * MEDIAN, not mean: one unusually large equipment month would otherwise inflate the
 * "untracked" estimate and turn an honest warning into an alarming one.
 *
 * THE NEWEST MONTH IS EXCLUDED when three or more months exist. Card history arrives
 * as statement imports, so the most recent recorded month is routinely a partial one —
 * here the last month on file holds only the 1st to the 3rd. Including a 3-day month
 * alongside full months would drag the typical figure far below reality and understate
 * the gap, which is the exact failure this warning exists to prevent. With fewer than
 * three months there is nothing to spare, so every month is used and the caller treats
 * the result as rough.
 */
export function typicalMonthlyCharges(months: CardMonth[]): number | null {
  if (months.length === 0) return null

  // `months` is newest-first by contract; sort defensively so a caller passing a
  // differently ordered array cannot silently drop the wrong month.
  const ordered = [...months].sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1))
  const usable = ordered.length >= 3 ? ordered.slice(1) : ordered
  if (usable.length === 0) return null

  const charges = usable.map((m) => m.charges).sort((a, b) => a - b)
  const mid = Math.floor(charges.length / 2)
  return charges.length % 2 === 1
    ? charges[mid]
    : (charges[mid - 1] + charges[mid]) / 2
}

export type CardActivity = {
  accountName: string
  txnCount: number
  firstTxnDate: string | null
  lastTxnDate: string | null
  /** `YYYY-MM` of the most recent recorded transaction. */
  lastTxnMonthKey: string | null
  /**
   * Whole CALENDAR MONTHS between the last recorded activity and the current month.
   * 0 means this month already has activity.
   *
   * Deliberately measured in months rather than days. Card history arrives here as a
   * monthly statement import, so a day-count threshold would either cry wolf a few
   * days before every import or stay silent through a genuinely missing month. The
   * calendar-month comparison needs no invented threshold and catches the real
   * defect: activity recorded through July while the calendar says August.
   */
  monthsBehind: number
  /** Reported as context alongside `monthsBehind`, never used as the alert trigger. */
  daysSinceLastTxn: number | null
  /** True when the newest recorded transaction predates the current month. */
  feedBehind: boolean
  /** Descending by month, most recent first. */
  months: CardMonth[]
  totalCharges: number
  totalPayments: number
  totalRefunds: number
  /**
   * charges − payments − refunds across RECORDED rows only.
   *
   * NOT a balance. See the module header: this is only the true balance if the card
   * was at zero on `firstTxnDate`. Always publish it with that caveat attached.
   */
  impliedNet: number
}

function daysBetweenDates(fromISO: string, today: Date): number | null {
  const then = new Date(fromISO + 'T00:00:00')
  if (Number.isNaN(then.getTime())) return null
  const midnightToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  )
  return Math.floor((midnightToday.getTime() - then.getTime()) / 86_400_000)
}

function todayMonthKey(today: Date): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
}

export type CardActivitySummary = {
  /** One entry per card account that has ledger rows, most active first. */
  accounts: CardActivity[]
  /** True when any card has recorded history at all. */
  hasData: boolean
  /** Cards whose newest transaction predates the current month. */
  behindCount: number
  /**
   * Ledger types found on card rows that are neither a charge nor a credit.
   *
   * Surfaced rather than silently skipped. If a future import introduces a new type,
   * the totals here would quietly stop adding up; naming the unknown type turns that
   * into a visible question instead of a wrong number.
   */
  unrecognizedTypes: string[]
}

/**
 * Roll card ledger rows up per account and per month.
 *
 * Pass only rows belonging to card accounts — this function does not know which
 * account names are cards, and summing a checking account here would be meaningless.
 */
export function summarizeCardActivity(
  rows: CardLedgerRow[],
  opts: { today: Date },
): CardActivitySummary {
  const byAccount = new Map<string, CardLedgerRow[]>()
  const unrecognized = new Set<string>()

  for (const r of rows) {
    const name = (r.accountName ?? '').trim()
    if (!name) continue
    if (!isCharge(r.transactionType) && !isCredit(r.transactionType)) {
      unrecognized.add(normalizeType(r.transactionType))
      // Still grouped, so the transaction count stays truthful even though the row
      // contributes nothing to the money totals.
    }
    const list = byAccount.get(name)
    if (list) list.push(r)
    else byAccount.set(name, [r])
  }

  const nowMonth = todayMonthKey(opts.today)

  const accounts: CardActivity[] = [...byAccount.entries()].map(([name, list]) => {
    const monthMap = new Map<string, CardMonth>()
    let totalCharges = 0
    let totalPayments = 0
    let totalRefunds = 0
    let firstTxnDate: string | null = null
    let lastTxnDate: string | null = null

    for (const r of list) {
      const date = (r.transactionDate ?? '').slice(0, 10)
      if (date) {
        if (firstTxnDate === null || date < firstTxnDate) firstTxnDate = date
        if (lastTxnDate === null || date > lastTxnDate) lastTxnDate = date
      }

      const mk = monthKeyOf(date)
      if (!mk) continue

      let bucket = monthMap.get(mk)
      if (!bucket) {
        bucket = { monthKey: mk, charges: 0, payments: 0, refunds: 0, txnCount: 0 }
        monthMap.set(mk, bucket)
      }
      bucket.txnCount += 1

      const amount = Number(r.amount)
      if (!Number.isFinite(amount)) continue
      // Guard the sign convention rather than trusting it: this database stores
      // magnitudes, so a negative value would mean an import wrote a different
      // convention and must not flip a charge into a credit.
      const magnitude = Math.abs(amount)
      const type = normalizeType(r.transactionType)

      if (isCharge(type)) {
        bucket.charges += magnitude
        totalCharges += magnitude
      } else if (type === 'payment') {
        bucket.payments += magnitude
        totalPayments += magnitude
      } else if (type === 'refund') {
        bucket.refunds += magnitude
        totalRefunds += magnitude
      }
    }

    const months = [...monthMap.values()].sort((a, b) =>
      a.monthKey < b.monthKey ? 1 : a.monthKey > b.monthKey ? -1 : 0,
    )

    const lastTxnMonthKey = lastTxnDate ? monthKeyOf(lastTxnDate) : null
    const monthsBehind = lastTxnMonthKey
      ? Math.max(0, monthsBetween(lastTxnMonthKey, nowMonth))
      : 0

    return {
      accountName: name,
      txnCount: list.length,
      firstTxnDate,
      lastTxnDate,
      lastTxnMonthKey,
      monthsBehind,
      daysSinceLastTxn: lastTxnDate
        ? daysBetweenDates(lastTxnDate, opts.today)
        : null,
      feedBehind: monthsBehind >= 1,
      months,
      totalCharges,
      totalPayments,
      totalRefunds,
      impliedNet: totalCharges - totalPayments - totalRefunds,
    }
  })

  accounts.sort((a, b) => b.txnCount - a.txnCount)

  return {
    accounts,
    hasData: accounts.length > 0,
    behindCount: accounts.filter((a) => a.feedBehind).length,
    unrecognizedTypes: [...unrecognized].sort(),
  }
}

// ---------------------------------------------------------------------------
// Reconciling recorded history against the confirmed balance

export type CardBalanceCheck = {
  accountName: string
  /**
   * The balance the owner confirmed. Null means never recorded — which must read as
   * "not recorded", never as $0. A literal zero on a card that runs thousands a
   * month reads as "paid off" and understates real exposure to nothing.
   */
  enteredOwed: number | null
  /** The ledger-derived figure. A cross-check, never presented as the balance. */
  impliedNet: number
  /** First recorded date — the date the zero-start assumption applies to. */
  baselineDate: string | null
  /** Last recorded date — the date the derived figure is current through. */
  throughDate: string | null
  /** enteredOwed − impliedNet. Null when no balance has been entered. */
  difference: number | null
  status: 'no_balance_entered' | 'matches' | 'differs'
  /** Plain-language notes, ALWAYS including the unconfirmed-baseline assumption. */
  notes: string[]
}

/**
 * Compare what the ledger implies against what the owner confirmed.
 *
 * There is deliberately NO tolerance threshold. A "close enough" band would be an
 * invented number, and worse, it would let a real discrepancy hide inside it. The
 * difference is reported exactly and both possible causes are named, because from
 * this data alone the two are genuinely indistinguishable:
 *
 *   1. the card already carried a balance before the history begins, or
 *   2. transactions are missing from the ledger.
 *
 * Picking one silently would turn a data question into a false conclusion.
 */
export function checkCardBalance(
  activity: CardActivity,
  enteredOwed: number | null,
  opts: { balanceConfirmed: boolean },
): CardBalanceCheck {
  const notes: string[] = []

  if (activity.firstTxnDate) {
    notes.push(
      `Assumes the card was at $0 on ${activity.firstTxnDate} — not confirmed.`,
    )
  }

  const hasEntered = opts.balanceConfirmed && enteredOwed !== null
  const difference = hasEntered ? (enteredOwed as number) - activity.impliedNet : null

  let status: CardBalanceCheck['status']
  if (!hasEntered) {
    status = 'no_balance_entered'
    notes.push(
      'No confirmed balance to compare against, so the figure above cannot be verified.',
    )
  } else if (Math.abs(difference as number) < 0.005) {
    status = 'matches'
    notes.push('Recorded history matches the confirmed balance.')
  } else {
    status = 'differs'
    const diff = difference as number
    notes.push(
      diff > 0
        ? 'The confirmed balance is higher than recorded history explains. That means either the card carried a balance before this history begins, or transactions are missing.'
        : 'The confirmed balance is lower than recorded history explains. That means either payments are missing from the ledger, or some recorded charges were later credited.',
    )
  }

  if (activity.feedBehind) {
    notes.push(
      `Card spending is only recorded through ${activity.lastTxnDate}, so anything since then is not included.`,
    )
  }

  return {
    accountName: activity.accountName,
    enteredOwed: hasEntered ? enteredOwed : null,
    impliedNet: activity.impliedNet,
    baselineDate: activity.firstTxnDate,
    throughDate: activity.lastTxnDate,
    difference,
    status,
    notes,
  }
}
