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
  statementCycle,
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
const STALE = { staleAfterDays: 14, cycleStaleAfterDays: 35 }

const card = (o: Partial<CreditAccountInput> = {}): CreditAccountInput => ({
  accountName: 'American Express ending 0-73009',
  accountType: 'Credit Card',
  currentBalance: 8000,
  creditLimit: 20000,
  availableCredit: 12000,
  statementBalance: null,
  statementDueDate: null,
  // A cycle that closed the day before TODAY, so the default fixture represents a
  // CURRENT statement. Existing assertions therefore keep their original meaning --
  // adding cycle tracking must not silently re-label every pre-existing case as
  // uncertain, or these tests would start passing for a new reason.
  statementPeriodStart: '2026-07-03',
  statementPeriodEnd: '2026-08-02',
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

console.log('\nUtilisation is a 0-1 ratio, not a percentage')
{
  // REGRESSION. The constraints panel rendered `Math.round(utilization)`, so 65%
  // exposure displayed as "1%" -- an understatement on the very figure meant to warn
  // about being maxed out. Pinning the unit here so the contract is explicit rather
  // than something each caller has to infer.
  const summary = assessCardSafety(
    [card({ creditLimit: 20000, currentBalance: 13000, availableCredit: 7000 })],
    TODAY,
    STALE,
  )
  check('utilisation is expressed as a ratio', summary.utilization, 0.65)
  ok(
    'and is never returned pre-scaled as a percentage',
    summary.utilization !== null && summary.utilization <= 1,
    String(summary.utilization),
  )
  check('per-card utilisation uses the same unit', summary.cards[0].utilization, 0.65)

  // The warning text is the one place that scales it, and must still read as percent.
  ok(
    'the 80% warning still reports whole percent',
    assessCardSafety(
      [card({ creditLimit: 10000, currentBalance: 9000, availableCredit: 1000 })],
      TODAY,
      STALE,
    ).cards[0].warnings.some((w) => w.includes('90%')),
    'expected a 90% warning',
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

console.log('\nStatement cycle: which bill does this balance actually cover?')
{
  // Not recorded and superseded are DIFFERENT problems with different remedies:
  // one needs the owner to enter cycle dates, the other needs the newer statement.
  // Collapsing them into one flag would tell the owner to do the wrong thing.
  const none = statementCycle(null, null, TODAY, 35)
  ok(
    'no cycle dates reads as not-recorded, NOT as superseded',
    none.notRecorded && !none.superseded && none.daysSinceClose === null,
  )

  const current = statementCycle('2026-07-03', '2026-08-02', TODAY, 35)
  ok(
    'a cycle that closed yesterday is current',
    !current.superseded && !current.notRecorded && current.daysSinceClose === 1,
  )

  // 35 days is the boundary: a monthly cycle plus a few days to issue and enter it.
  ok(
    'a cycle closed exactly at the threshold is still current',
    !statementCycle('2026-05-30', '2026-06-29', TODAY, 35).superseded,
  )
  ok(
    'a cycle closed past the threshold is superseded',
    statementCycle('2026-05-29', '2026-06-28', TODAY, 35).superseded,
  )
  check(
    'the cycle label is owner-readable',
    statementCycle('2026-07-04', '2026-08-03', TODAY, 35).label,
    'cycle 4 Jul - 3 Aug',
  )
}

console.log('\nA statement is only trusted when its cycle is provably current')
{
  // THE REAL CASE. The active Amex sat at a $2 statement against a ~$9,948 balance.
  // `lastUpdated` was today, so every freshness check passed and the timing check
  // waved a $2 payment through as trivially safe. Only the CYCLE can catch this.
  const staleCycle = assessCardSafety(
    [
      card({
        statementBalance: 2,
        statementDueDate: '2026-08-18',
        statementPeriodStart: '2026-04-04',
        statementPeriodEnd: '2026-05-03', // closed ~92 days before TODAY
        lastUpdated: '2026-08-03', // typed today -- looks perfectly fresh
      }),
    ],
    TODAY,
    STALE,
  )
  const c = staleCycle.cards[0]
  ok('a superseded cycle is detected even when the figure was typed today', c.cycle.superseded)
  ok('...and the freshness check alone would NOT have caught it', !c.freshness.isStale)
  ok('...so the statement is not treated as current', !c.statementIsCurrent)
  ok(
    '...and it is reported as superseded rather than merely missing',
    c.warnings.some((w) => /closed \d+ days ago/i.test(w)),
  )
  check(
    '...and it drags summary confidence down',
    staleCycle.confidence,
    'reduced',
  )
  check('...and is counted', staleCycle.uncertainStatementCount, 1)

  // Balance recorded, cycle absent: flagged, but with the OTHER message.
  const noCycle = assessCardSafety(
    [
      card({
        statementBalance: 10904.4,
        statementDueDate: '2026-08-18',
        statementPeriodStart: null,
        statementPeriodEnd: null,
      }),
    ],
    TODAY,
    STALE,
  )
  ok('a missing cycle is also untrusted', !noCycle.cards[0].statementIsCurrent)
  ok(
    '...and asks for the cycle dates, not a newer statement',
    noCycle.cards[0].warnings.some((w) => /cycle dates not recorded/i.test(w)),
  )

  // The real, corrected Amex row must come out clean -- otherwise the guard would
  // nag about correct data, which is how warnings get ignored.
  const good = assessCardSafety(
    [
      card({
        statementBalance: 10904.4,
        statementDueDate: '2026-08-18',
        statementPeriodStart: '2026-07-04',
        statementPeriodEnd: '2026-08-03',
        lastUpdated: '2026-08-03',
      }),
    ],
    TODAY,
    STALE,
  )
  ok('the corrected Amex row is trusted', good.cards[0].statementIsCurrent)
  check('...with no cycle warning', good.cards[0].warnings.length, 0)
  check('...and full confidence', good.confidence, 'high')

  // No statement recorded is NOT a cycle problem -- it has its own warning already,
  // and double-reporting it would push confidence down twice for one missing figure.
  const settled = assessCardSafety(
    [card({ currentBalance: 0, availableCredit: 20000, statementBalance: null })],
    TODAY,
    STALE,
  )
  ok('a paid-off card is not flagged as uncertain', settled.cards[0].statementIsCurrent)

  const noStatement = assessCardSafety(
    [card({ statementBalance: null, statementPeriodStart: null, statementPeriodEnd: null })],
    TODAY,
    STALE,
  )
  ok(
    'a card with no statement is not double-reported as a cycle problem',
    noStatement.cards[0].statementIsCurrent &&
      noStatement.uncertainStatementCount === 0,
  )
  ok(
    '...it is still reported once, as an untracked statement',
    noStatement.cards[0].warnings.some((w) => /statement balance not tracked/i.test(w)),
  )
}

console.log('\nAn uncertain statement is still reported, just not as fact')
{
  // Suppressing the conflict would HIDE real exposure -- the opposite failure. It
  // must still fire, flagged as unconfirmed.
  const summary = assessCardSafety(
    [
      card({
        statementBalance: 9948,
        statementDueDate: '2026-08-18',
        statementPeriodStart: '2026-04-04',
        statementPeriodEnd: '2026-05-03',
      }),
    ],
    TODAY,
    STALE,
  )
  const conflicts = findDueDateConflicts(summary, '2026-08-10', { windowDays: 14 })
  check('the conflict is still raised', conflicts.length, 1)
  ok('but marked unconfirmed', conflicts[0].amountConfirmed === false)
  ok(
    'and the message says to confirm the current statement',
    /confirm the current statement/i.test(conflicts[0].message),
  )

  const confirmed = findDueDateConflicts(
    assessCardSafety(
      [
        card({
          statementBalance: 10904.4,
          statementDueDate: '2026-08-18',
          statementPeriodStart: '2026-07-04',
          statementPeriodEnd: '2026-08-03',
        }),
      ],
      TODAY,
      STALE,
    ),
    '2026-08-10',
    { windowDays: 14 },
  )
  ok('a current statement is reported as confirmed', confirmed[0].amountConfirmed)
  ok(
    '...with no hedging in the message',
    !/unconfirmed|confirm the current/i.test(confirmed[0].message),
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
