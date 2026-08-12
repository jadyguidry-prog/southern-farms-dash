/**
 * Bill reminders and stale-check detection. PURE — no clock, no database, no env.
 * The caller reads the clock once and passes `today` in, so two panels rendered in the
 * same request can never straddle midnight and disagree.
 *
 * Two ideas here that must not be conflated:
 *
 *  - A bill with a VENDOR due date can be late. Missing it has consequences.
 *  - A SELF-SCHEDULED bill (no due date on the invoice) cannot be late, because no
 *    deadline exists to miss. Its date is a plan. Calling it "overdue" would invent an
 *    obligation the vendor never set and train the owner to ignore the word.
 *
 * And separately: an uncleared check is flagged when it has been outstanding too long,
 * but it is ALWAYS still counted as owed. The money has not left the account, so removing
 * it from the totals would overstate available cash — which is the opposite of the
 * cautious error. Flagging and excluding are different actions.
 */

import { daysBetweenDates } from './spending-capacity-service'

/** How a bill relates to its date. Ordered most to least pressing. */
export type BillUrgency =
  /** Past a real vendor due date. Only possible when `selfScheduled` is false. */
  | 'overdue'
  /** Due today against a real vendor deadline. */
  | 'due-today'
  /** Within the reminder lead time. */
  | 'due-soon'
  /**
   * A self-scheduled bill whose planned date has passed. NOT late — there is no vendor
   * deadline — but it still needs a check written, so it must stay visible.
   */
  | 'unpaid-planned'
  /** Beyond the lead time. Returned for completeness; not shown as a reminder. */
  | 'upcoming'

export type BillReminderInput = {
  id: string
  label: string
  amount: number
  /** Effective next due date, ISO. Already rolled forward by the caller. */
  dueDate: string
  /** True when the vendor sets no deadline and this date is the owner's own plan. */
  selfScheduled: boolean
  /**
   * ISO date of the most recent payment recorded against this obligation, or null.
   * Used to suppress a reminder for a bill already handled this cycle — a reminder for
   * something already paid is noise, and noise is how real reminders get ignored.
   */
  lastPaymentDate: string | null
  /**
   * Start of the current cycle, ISO. A payment on or after this covers this cycle.
   * Null for a one-off, where any recorded payment at all settles it.
   */
  cycleStart: string | null
}

export type BillReminder = {
  id: string
  label: string
  amount: number
  dueDate: string
  /** Negative when the date has passed. */
  daysUntil: number
  urgency: BillUrgency
  selfScheduled: boolean
}

export type UnclearedCheckInput = {
  /** Check number, or null when one was never recorded. */
  checkNumber: string | null
  payee: string | null
  amount: number
  /** ISO date the check was written. */
  paymentDate: string
}

export type StaleCheck = UnclearedCheckInput & {
  daysOutstanding: number
}

export type BillReminderResult = {
  /** Everything needing action now, most pressing first. Excludes `upcoming`. */
  due: BillReminder[]
  /** Dated beyond the lead time. Kept so callers can show what is next. */
  upcoming: BillReminder[]
  /**
   * Uncleared checks outstanding longer than the staleness threshold. These are FLAGGED
   * ONLY — they remain in every total, because the money has not actually left.
   */
  staleChecks: StaleCheck[]
  /** Total still owed across `due`. */
  dueTotal: number
  /**
   * The owner-set thresholds this result was computed with, echoed back so every consumer
   * quotes the same numbers instead of re-reading settings and risking a mismatch.
   */
  leadDays: number
  staleCheckAfterDays: number
}

const URGENCY_ORDER: Record<BillUrgency, number> = {
  overdue: 0,
  'due-today': 1,
  'unpaid-planned': 2,
  'due-soon': 3,
  upcoming: 4,
}

/**
 * True when a payment already covers the current cycle.
 *
 * For a recurring bill only a payment on or after the cycle start counts: LAST month's
 * check must not silence THIS month's reminder, which would hide a genuinely unpaid bill
 * behind stale history.
 */
function isSettled(bill: BillReminderInput): boolean {
  if (!bill.lastPaymentDate) return false
  if (!bill.cycleStart) return true
  return daysBetweenDates(bill.cycleStart, bill.lastPaymentDate) >= 0
}

function classify(
  bill: BillReminderInput,
  daysUntil: number,
  leadDays: number,
): BillUrgency {
  if (bill.selfScheduled) {
    // No vendor deadline exists, so this can never be 'overdue'. Past its planned date it
    // still needs paying, which is a prompt, not a failure.
    if (daysUntil <= 0) return 'unpaid-planned'
    return daysUntil <= leadDays ? 'due-soon' : 'upcoming'
  }
  if (daysUntil < 0) return 'overdue'
  if (daysUntil === 0) return 'due-today'
  return daysUntil <= leadDays ? 'due-soon' : 'upcoming'
}

export function buildBillReminders(input: {
  bills: BillReminderInput[]
  unclearedChecks: UnclearedCheckInput[]
  today: string
  /** Days ahead a bill starts reminding. Owner-set; never defaulted by this module. */
  leadDays: number
  /** Days after which an uncleared check is suspicious. Owner-set. */
  staleCheckAfterDays: number
}): BillReminderResult {
  const { bills, unclearedChecks, today, leadDays, staleCheckAfterDays } = input

  const classified = bills
    // A bill with no date cannot be scheduled, and guessing one would be inventing data.
    .filter((b) => b.dueDate)
    // Already handled this cycle: nothing to remind about.
    .filter((b) => !isSettled(b))
    .map((b): BillReminder => {
      const daysUntil = daysBetweenDates(today, b.dueDate)
      return {
        id: b.id,
        label: b.label,
        amount: b.amount,
        dueDate: b.dueDate,
        daysUntil,
        urgency: classify(b, daysUntil, leadDays),
        selfScheduled: b.selfScheduled,
      }
    })
    .sort(
      (a, z) =>
        URGENCY_ORDER[a.urgency] - URGENCY_ORDER[z.urgency] ||
        a.daysUntil - z.daysUntil ||
        z.amount - a.amount,
    )

  const due = classified.filter((c) => c.urgency !== 'upcoming')

  const staleChecks = unclearedChecks
    .map((c) => ({ ...c, daysOutstanding: daysBetweenDates(c.paymentDate, today) }))
    .filter((c) => c.daysOutstanding > staleCheckAfterDays)
    .sort((a, z) => z.daysOutstanding - a.daysOutstanding)

  return {
    due,
    upcoming: classified.filter((c) => c.urgency === 'upcoming'),
    staleChecks,
    dueTotal: due.reduce((s, c) => s + c.amount, 0),
    leadDays,
    staleCheckAfterDays,
  }
}

/** Human phrasing for one reminder. Kept here so every surface words it identically. */
export function describeReminder(r: BillReminder): string {
  const days = Math.abs(r.daysUntil)
  const dayWord = days === 1 ? 'day' : 'days'
  switch (r.urgency) {
    case 'overdue':
      return `${days} ${dayWord} past due`
    case 'due-today':
      return 'Due today'
    case 'unpaid-planned':
      // Deliberately not "late": no vendor deadline exists to be late against.
      return days === 0
        ? 'Planned for today, not yet paid'
        : `Planned ${days} ${dayWord} ago, not yet paid`
    case 'due-soon':
      return days === 1 ? 'Due tomorrow' : `Due in ${days} ${dayWord}`
    case 'upcoming':
      return `Due in ${days} ${dayWord}`
  }
}
