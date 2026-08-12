/**
 * THE single loader for credit-card exposure.
 *
 * Every surface that talks about cards — Dashboard, Cash & Debt, the Advisor and the
 * report — must read this one function. That is not a style preference: a previous
 * bug in this codebase had the growth proposals LIST rendering a stored verdict while
 * the DETAIL page recomputed it live, so a commitment that had become unaffordable
 * kept a stale green badge. Two surfaces reading the same table are not automatically
 * consistent. One shared, `cache()`-wrapped loader makes disagreement impossible
 * within a request.
 *
 * This is the impure edge: it reads the database and the clock ONCE, then hands
 * `today` down to the pure engines (`card-safety.ts` for the account row,
 * `card-activity.ts` for the ledger) so their results stay reproducible and testable.
 */

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getBankAccounts, getBusinessSettings } from '@/lib/queries'
import {
  assessCardSafety,
  CARD_ACCOUNT_TYPE,
  HIGH_UTILIZATION_THRESHOLD,
  type CardSafetySummary,
} from '@/lib/card-safety'
import {
  summarizeCardActivity,
  summarizeCardFreshness,
  checkCardBalance,
  typicalMonthlyCharges,
  type CardActivity,
  type CardBalanceCheck,
  type CardLedgerRow,
} from '@/lib/card-activity'

const PAGE_SIZE = 1000

/**
 * Read a setting that must exist. Never `?? 0`.
 *
 * A failed settings read once reported a $0 reserve and $16,185 spendable when the
 * truth was $15,000 and $1,437. A missing row is an error, not a default.
 */
function requireSetting(
  settings: Awaited<ReturnType<typeof getBusinessSettings>>,
  key: string,
): number {
  const row = settings.rows.find((r) => r.key === key)
  if (!row || !Number.isFinite(row.value)) {
    throw new Error(
      `business_settings.${key} is missing or not a number. Card exposure will not substitute a guess.`,
    )
  }
  return row.value
}

/**
 * Every ledger row belonging to one of the named card accounts.
 *
 * Paginated because Supabase caps a select at 1,000 rows by default. Without this a
 * busy card would silently lose its oldest history and quietly understate spend —
 * the failure would look like a smaller number, not an error.
 */
async function readCardLedger(accountNames: string[]): Promise<CardLedgerRow[]> {
  if (accountNames.length === 0) return []
  const supabase = await createClient()
  const out: CardLedgerRow[] = []

  for (let page = 0; ; page += 1) {
    const { data, error } = await supabase
      .from('financial_transactions')
      .select('transaction_date, transaction_type, amount, account_name')
      .is('deleted_at', null)
      .in('account_name', accountNames)
      .order('transaction_date', { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

    if (error) throw new Error(`financial_transactions: ${error.message}`)
    const rows = data ?? []
    out.push(
      ...rows.map((t) => ({
        accountName: String(t.account_name ?? ''),
        transactionDate: String(t.transaction_date ?? ''),
        transactionType: String(t.transaction_type ?? ''),
        amount: Number(t.amount),
      })),
    )
    if (rows.length < PAGE_SIZE) break
  }

  return out
}

export type CardExposureCard = {
  accountName: string
  /**
   * Date the card was closed; null means open. A closed card keeps its balance and
   * history and still counts toward what is owed, but is never reported as having a
   * stale feed — no further statements will arrive for it.
   */
  closedAt: string | null
  /** Amount owed as confirmed by the owner. Null when never confirmed. */
  owed: number | null
  limit: number | null
  headroom: number | null
  utilization: number | null
  statementBalance: number | null
  statementDueDate: string | null
  daysUntilDue: number | null
  /** Owner-facing cycle phrase, e.g. "cycle 4 Jul - 3 Aug". Null when not recorded. */
  statementCycleLabel: string | null
  /**
   * False when the recorded statement cannot be shown to be the current one. The
   * amount is still displayed — hiding it would understate exposure — but must be
   * presented as unconfirmed rather than as fact.
   */
  statementIsCurrent: boolean
  /** How old the hand-entered balance is. */
  balanceLabel: string
  balanceNeverRecorded: boolean
  balanceStale: boolean
  /** Ledger-side history. Null when this card has no recorded transactions. */
  activity: CardActivity | null
  /** Reconciliation of history against the confirmed balance. Null without history. */
  balanceCheck: CardBalanceCheck | null
  warnings: string[]
}

export type CardExposure = {
  cards: CardExposureCard[]
  /**
   * Total confirmed owed across cards. Null when NO card has a confirmed balance —
   * distinct from 0, which would read as "everything is paid off".
   */
  totalOwed: number | null
  /** How many cards have a confirmed balance, and how many exist at all. */
  confirmedCount: number
  cardCount: number
  /**
   * Sum of amounts owed, but ONLY when every card has a confirmed balance. Null the
   * moment any card is unrecorded, because a partial sum presented as the total is
   * indistinguishable from a real total and understates debt.
   */
  // (declared above alongside the other aggregates; see confirmedSubtotal for the
  // partial figure)
  /**
   * Sum across the cards that DO have a confirmed balance, even when others do not.
   * Only safe to display next to an explicit "incomplete" qualifier.
   */
  confirmedSubtotal: number | null
  /** Cards whose recorded spending stops before the current month. */
  behindCount: number
  /**
   * Whole calendar months the WORST-lagging card is behind. 0 means every card has
   * activity recorded in the current month.
   */
  monthsBehind: number
  /**
   * Median monthly charge volume pooled across cards, for sizing how much spending a
   * stale feed is hiding. Null when there is no usable month.
   */
  typicalMonthlyCharges: number | null
  /**
   * Cards at or above the shared high-utilisation threshold. Cards with no recorded
   * credit limit are absent, never treated as having free headroom.
   */
  highUtilization: { accountName: string; utilizationPct: number }[]
  /** Most recent recorded card transaction across ALL cards, open or closed. */
  lastActivityDate: string | null
  /**
   * Most recent recorded transaction among OPEN cards. Always consistent with
   * `monthsBehind`; use this for anything describing how stale the feed is.
   */
  lastOpenActivityDate: string | null
  /** Cards that are still open. Closed cards keep their balance but never go "stale". */
  openCardCount: number
  /** True when at least one card account exists. */
  hasCards: boolean
  /** True when at least one card has recorded transactions. */
  hasActivity: boolean
  /** Aggregate, owner-readable problems worth surfacing. */
  warnings: string[]
  /** Unknown ledger types found on card rows — see `card-activity.ts`. */
  unrecognizedTypes: string[]
  /** Carried through from the account-row engine. */
  safety: CardSafetySummary
  meta: {
    todayISO: string
    staleAfterDays: number
  }
}

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

export const getCardExposure = cache(async (): Promise<CardExposure> => {
  const [accounts, settings] = await Promise.all([
    getBankAccounts(),
    getBusinessSettings(),
  ])

  const staleAfterDays = requireSetting(settings, 'account_data_stale_days')
  const cycleStaleAfterDays = requireSetting(
    settings,
    'card_statement_cycle_stale_days',
  )

  // The clock is read exactly once here and passed down, so two panels rendered in
  // the same request cannot straddle midnight and disagree.
  const today = new Date()

  // Cards only. `assessCardSafety` also accepts a line of credit, but this module
  // reports CARD exposure; folding the $15,000 drawn line into "card owed" would
  // overstate card spending by more than the cards themselves.
  const cardAccounts = accounts.filter((a) => a.accountType === CARD_ACCOUNT_TYPE)

  const safety = assessCardSafety(cardAccounts, today, {
    staleAfterDays,
    cycleStaleAfterDays,
  })

  const ledger = await readCardLedger(cardAccounts.map((a) => a.accountName))
  const activity = summarizeCardActivity(ledger, { today })

  const cards: CardExposureCard[] = cardAccounts.map((account) => {
    const assessment = safety.cards.find(
      (c) => c.accountName === account.accountName,
    )
    const act =
      activity.accounts.find((a) => a.accountName === account.accountName) ?? null

    // A balance is only "confirmed" if someone recorded WHEN they confirmed it. A
    // row that has never been touched holds 0 by database default, and treating that
    // as a real zero is precisely how a card running thousands a month reads as
    // paid off.
    const balanceConfirmed = !(assessment?.freshness.neverRecorded ?? true)
    const owed = balanceConfirmed ? (assessment?.owed ?? null) : null
    const limitKnown = (assessment?.limit ?? 0) > 0

    return {
      accountName: account.accountName,
      closedAt: account.closedAt,
      owed,
      limit: limitKnown ? (assessment?.limit ?? null) : null,
      headroom: assessment?.headroom ?? null,
      utilization: assessment?.utilization ?? null,
      statementBalance: assessment?.statementBalance ?? null,
      statementDueDate: assessment?.statementDueDate ?? null,
      daysUntilDue: assessment?.daysUntilDue ?? null,
      statementCycleLabel: assessment?.cycle.notRecorded
        ? null
        : (assessment?.cycle.label ?? null),
      // Defaults to true when there is no assessment at all: absence of a statement is
      // reported by its own warning, so defaulting to false here would invent a second
      // complaint about the same missing figure.
      statementIsCurrent: assessment?.statementIsCurrent ?? true,
      balanceLabel: assessment?.freshness.label ?? 'never confirmed',
      balanceNeverRecorded: assessment?.freshness.neverRecorded ?? true,
      balanceStale: assessment?.freshness.isStale ?? true,
      activity: act,
      balanceCheck: act
        ? checkCardBalance(act, owed, { balanceConfirmed })
        : null,
      warnings: assessment?.warnings ?? [],
    }
  })

  const confirmed = cards.filter((c) => c.owed !== null)

  // A total built from SOME cards is not the total owed, and displaying it as one is
  // how a real bug reached the screen: the retired 0-72001 card has a genuine
  // confirmed $0 while the ACTIVE card's balance has never been entered, so summing
  // only confirmed cards produced a headline "$0" on a business that charges
  // thousands a month. Per-card handling was already correct; the aggregate was the
  // liar.
  //
  // So the total is only a number when EVERY card is confirmed. When any card is
  // missing, `totalOwed` stays null (rendered "Not recorded") and
  // `confirmedSubtotal` carries the partial figure for callers that explicitly want
  // to show "at least this much, and it is incomplete".
  const allConfirmed = confirmed.length === cards.length && cards.length > 0
  const confirmedSubtotal =
    confirmed.length > 0
      ? confirmed.reduce((s, c) => s + (c.owed as number), 0)
      : null
  const totalOwed = allConfirmed ? confirmedSubtotal : null

  const lastActivityDate =
    activity.accounts.reduce<string | null>((latest, a) => {
      if (!a.lastTxnDate) return latest
      return latest === null || a.lastTxnDate > latest ? a.lastTxnDate : latest
    }, null) ?? null

  // ---- Aggregate warnings -------------------------------------------------
  // Ordered most-actionable first. Each one names the specific card and what to do,
  // because "card data is incomplete" is not something the owner can act on.
  // Freshness questions are asked of OPEN cards only. A closed card's feed stopping is
  // the correct outcome, not a problem: card 0-72001 was replaced in Dec 2025, so
  // telling the owner to "import the latest statement" for it is noise — and noise is
  // what trains someone to ignore the real staleness alert that this whole module
  // exists to raise.
  //
  // Closed cards are excluded ONLY from freshness. They stay in the owed total and keep
  // their history and their reconciliation notes, because a closed card can still
  // carry a balance.
  const openCards = cards.filter((c) => c.closedAt === null)

  const warnings: string[] = []

  for (const c of openCards) {
    if (c.activity?.feedBehind) {
      const months = c.activity.monthsBehind
      warnings.push(
        `${c.accountName}: spending is only recorded through ${c.activity.lastTxnDate}` +
          ` (${months} ${months === 1 ? 'month' : 'months'} behind). Import the statement to close the gap.`,
      )
    }
  }

  for (const c of cards) {
    if (c.balanceNeverRecorded) {
      warnings.push(
        `${c.accountName}: amount owed has never been recorded, so it is reported as not tracked rather than $0.`,
      )
    } else if (c.balanceStale) {
      warnings.push(`${c.accountName}: amount owed was ${c.balanceLabel}.`)
    }
  }

  for (const c of cards) {
    if (c.balanceCheck?.status === 'differs') {
      const diff = Math.abs(c.balanceCheck.difference as number)
      warnings.push(
        `${c.accountName}: recorded history and the confirmed balance differ by ${diff.toFixed(2)}.` +
          ' Either the card carried a balance before the history begins, or transactions are missing.',
      )
    }
  }

  if (cardAccounts.length === 0) {
    warnings.push('No credit cards are set up, so card spending cannot be tracked.')
  }

  if (activity.unrecognizedTypes.length > 0) {
    warnings.push(
      `Card transactions include unrecognized types (${activity.unrecognizedTypes.join(', ')}), which are counted but excluded from spend totals.`,
    )
  }

  // One pure, tested definition of feed freshness, shared so `behindCount`,
  // `monthsBehind` and the quoted date are always scoped the same way.
  const freshness = summarizeCardFreshness(cards)

  // Pooled across OPEN cards, because this figure sizes what is still being spent and
  // not captured. Including the replaced card's December history would blend spending
  // that has permanently stopped into an estimate of ongoing spending.
  const openMonths = openCards.flatMap((c) => c.activity?.months ?? [])
  const typical = typicalMonthlyCharges(openMonths)

  // Only cards whose limit is genuinely known can have a utilization. Cards with no
  // recorded limit are left out entirely rather than assumed to have room.
  const highUtilization = cards
    .filter((c) => c.utilization !== null && c.utilization >= HIGH_UTILIZATION_THRESHOLD)
    .map((c) => ({
      accountName: c.accountName,
      // Stored as a fraction upstream; the advisor renders a percentage.
      utilizationPct: (c.utilization as number) * 100,
    }))

  return {
    cards,
    totalOwed,
    confirmedSubtotal,
    confirmedCount: confirmed.length,
    cardCount: cardAccounts.length,
    // All three come from `summarizeCardFreshness`, NOT from `activity.behindCount`:
    // the ledger-derived count has no idea which accounts still exist, so it would
    // report the replaced card as a problem forever.
    behindCount: freshness.behindCount,
    monthsBehind: freshness.monthsBehind,
    lastOpenActivityDate: freshness.lastOpenActivityDate,
    typicalMonthlyCharges: typical,
    highUtilization,
    lastActivityDate,
    openCardCount: openCards.length,
    hasCards: cardAccounts.length > 0,
    hasActivity: activity.hasData,
    warnings,
    unrecognizedTypes: activity.unrecognizedTypes,
    safety,
    meta: {
      todayISO: toISODate(today),
      staleAfterDays,
    },
  }
})
