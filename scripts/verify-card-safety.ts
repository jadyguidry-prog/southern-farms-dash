/**
 * Checks for the card-safety and data-freshness engine.
 *
 * Every block here pins a rule where the wrong choice produces a plausible but
 * dangerous number:
 *   - an untracked statement balance read as 0, making a card look paid off
 *   - an untaken loan offer parked on a savings row read as borrowing headroom
 *   - a card with no recorded limit contributing assumed headroom
 *   - a month-old hand-entered balance trusted as if confirmed today
 *   - a commitment scheduled days before a large statement comes due
 *
 * Run: npx tsx scripts/verify-card-safety.ts
 */
import {
  accountFreshness,
  assessCardSafety,
  findDueDateConflicts,
  isCreditAccount,
  type CreditAccountInput,
} from '../lib/card-safety'

let pass = 0
let fail = 0
const failures: string[] = []

function check<T>(label: string, actual: T, expected: T) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    failures.push(`${label}: expected ${e}, got ${a}`)
  }
}
function ok(label: string, cond: boolean, detail = '') {
  if (cond) pass++
  else {
    fail++
    failures.push(detail ? `${label} — ${detail}` : label)
  }
}

// Fixed "today" so results never depend on when the suite runs.
const TODAY = new Date(2026, 7, 3) // 2026-08-03
const STALE = { staleAfterDays: 14 }

const card = (o: Partial<CreditAccountInput> = {}): CreditAccountInput => ({
  accountName: 'American Express ending 0-73009',
  accountType: 'Credit Card',
  currentBalance: 8000,
  creditLimit: 20000,
  availableCredit: 12000,
  statementBalance: null,
  statementDueDate: null,
  lastUpdated: '2026-08-03',
  ...o,
})

console.log('Account type classification')
{
  check('a credit card is a credit account', isCreditAccount('Credit Card'), true)
  check('a line of credit is a credit account', isCreditAccount('Line of Credit'), true)
  // The Square Capital trap: an offer stored on a deposit row must never be swept in.
  check('savings is not a credit account', isCreditAccount('Savings'), false)
  check('checking is not a credit account', isCreditAccount('Checking'), false)
}

console.log('\nFreshness of hand-entered figures')
{
  check('same day reads as fresh', accountFreshness('2026-08-03', TODAY, 14).ageDays, 0)
  check(
    'a 14-day-old figure is still within the threshold',
    accountFreshness('2026-07-20', TODAY, 14).isStale,
    false,
  )
  check(
    'a 15-day-old figure is stale',
    accountFreshness('2026-07-19', TODAY, 14).isStale,
    true,
  )
  // Never recorded is weaker than merely old: there is no evidence it was ever true.
  const never = accountFreshness('', TODAY, 14)
  ok(
    'never-confirmed counts as stale and is flagged',
    never.isStale && never.neverRecorded && never.ageDays === null,
  )
  // A typo'd future date must not read as extra-fresh.
  const future = accountFreshness('2026-09-01', TODAY, 14)
  ok('a future date is flagged rather than trusted', future.isStale)
  ok('an unreadable date is flagged', accountFreshness('not-a-date', TODAY, 14).isStale)
}

console.log('\nHeadroom is only counted when the limit is known')
{
  const known = assessCardSafety([card()], TODAY, STALE)
  check('known limit contributes headroom', known.totalHeadroom, 12000)
  check('utilisation is reported', known.utilization, 0.4)

  // No limit recorded: headroom is unknowable, so it must contribute nothing rather
  // than an assumed figure that would inflate capacity.
  const unknown = assessCardSafety(
    [card({ creditLimit: 0, availableCredit: 0 })],
    TODAY,
    STALE,
  )
  check('unknown limit contributes no headroom', unknown.totalHeadroom, 0)
  check('unknown limit yields null headroom', unknown.cards[0].headroom, null)
  check('unknown limit yields null utilisation', unknown.cards[0].utilization, null)
  check('unknown limit lowers confidence', unknown.confidence, 'reduced')
  ok(
    'unknown limit is explained to the owner',
    unknown.cards[0].warnings.some((w) => w.includes('credit limit not recorded')),
  )
}

console.log('\nDeposit accounts never contribute borrowing capacity')
{
  // The exact Square Savings situation: a $56,750 limit / $47,480.44 "available
  // credit" that was really an untaken Square Capital loan offer.
  const summary = assessCardSafety(
    [
      {
        accountName: 'Square Savings',
        accountType: 'Savings',
        currentBalance: 7042.65,
        creditLimit: 56750,
        availableCredit: 47480.44,
        lastUpdated: '2026-08-03',
      },
    ],
    TODAY,
    STALE,
  )
  check('a savings row contributes no headroom', summary.totalHeadroom, 0)
  check('a savings row is not treated as a credit account', summary.cards.length, 0)
  check('with no credit accounts, confidence is missing', summary.confidence, 'missing')
  ok(
    'the absence of card data is stated plainly',
    summary.warnings.some((w) => w.includes('No credit cards')),
  )
}

console.log('\nAn untracked statement is not a paid-off card')
{
  const s = assessCardSafety(
    [card({ currentBalance: 8000, statementBalance: null })],
    TODAY,
    STALE,
  )
  check('null statement stays null', s.cards[0].statementBalance, null)
  ok(
    'a carried balance with no statement tracked is flagged',
    s.cards[0].warnings.some((w) => w.includes('statement balance not tracked')),
  )

  // A genuine zero is different from untracked and must not be warned about.
  const paid = assessCardSafety(
    [card({ currentBalance: 0, availableCredit: 20000, statementBalance: 0 })],
    TODAY,
    STALE,
  )
  ok(
    'a genuinely paid-off card is not flagged as untracked',
    !paid.cards[0].warnings.some((w) => w.includes('not tracked')),
  )
}

console.log('\nStale figures still answer, but lower confidence')
{
  const stale = assessCardSafety([card({ lastUpdated: '2026-06-01' })], TODAY, STALE)
  check('stale data still yields a headroom figure', stale.totalHeadroom, 12000)
  check('stale data lowers confidence', stale.confidence, 'reduced')
  check('stale accounts are counted', stale.staleCount, 1)
  ok(
    'the age is shown rather than hidden',
    stale.cards[0].warnings.some((w) => w.includes('63 days ago')),
    JSON.stringify(stale.cards[0].warnings),
  )

  const fresh = assessCardSafety([card()], TODAY, STALE)
  check('fresh, fully-recorded data is high confidence', fresh.confidence, 'high')
}

console.log('\nHigh utilisation is surfaced')
{
  const hot = assessCardSafety(
    [card({ currentBalance: 17000, availableCredit: 3000 })],
    TODAY,
    STALE,
  )
  ok(
    '85% utilisation is called out',
    hot.cards[0].warnings.some((w) => w.includes('85%')),
    JSON.stringify(hot.cards[0].warnings),
  )
}

console.log('\nOverdue statements are reported')
{
  const overdue = assessCardSafety(
    [card({ statementBalance: 4200, statementDueDate: '2026-07-28' })],
    TODAY,
    STALE,
  )
  check('days until due goes negative when overdue', overdue.cards[0].daysUntilDue, -6)
  ok(
    'an overdue statement is stated in days',
    overdue.cards[0].warnings.some((w) => w.includes('due 6 days ago')),
    JSON.stringify(overdue.cards[0].warnings),
  )
}

console.log('\nTiming a commitment against statement due dates')
{
  const summary = assessCardSafety(
    [card({ statementBalance: 9500, statementDueDate: '2026-08-20' })],
    TODAY,
    STALE,
  )

  // Spending days before a large statement is the real risk this catches.
  const clash = findDueDateConflicts(summary, '2026-08-17', { windowDays: 10 })
  check('a statement due 3 days later is flagged', clash.length, 1)
  check('the gap is reported', clash[0].gapDays, 3)

  // Far enough away to be irrelevant.
  const clear = findDueDateConflicts(summary, '2026-08-01', { windowDays: 10 })
  check('a statement outside the window is not flagged', clear.length, 0)

  // Already paid before the commitment: competes for nothing.
  const past = findDueDateConflicts(summary, '2026-08-25', { windowDays: 10 })
  check('a statement already past is not flagged', past.length, 0)

  // An untracked statement is reported as missing data elsewhere, not guessed at.
  const untracked = assessCardSafety(
    [card({ statementBalance: null, statementDueDate: '2026-08-20' })],
    TODAY,
    STALE,
  )
  check(
    'an untracked statement raises no false conflict',
    findDueDateConflicts(untracked, '2026-08-17', { windowDays: 10 }).length,
    0,
  )
}

console.log('\nTwo separate cards aggregate independently')
{
  const summary = assessCardSafety(
    [
      card({ accountName: 'Amex ...73009', creditLimit: 20000, currentBalance: 8000, availableCredit: 12000 }),
      card({ accountName: 'Amex ...72001', creditLimit: 10000, currentBalance: 1000, availableCredit: 9000 }),
      {
        accountName: 'Business Line of Credit',
        accountType: 'Line of Credit',
        currentBalance: 15000,
        creditLimit: 35000,
        availableCredit: 20000,
        lastUpdated: '2026-08-03',
      },
    ],
    TODAY,
    STALE,
  )
  check('owed totals across all credit accounts', summary.totalOwed, 24000)
  check('limits total across all credit accounts', summary.totalLimit, 65000)
  check('headroom totals across all credit accounts', summary.totalHeadroom, 41000)
  ok('blended utilisation is reported', Math.abs((summary.utilization ?? 0) - 24000 / 65000) < 1e-9)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
