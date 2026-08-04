/**
 * Checks how a card payoff reaches the cash forecast, and that adding it cannot
 * double-count money that is already in the spending baseline.
 *
 * WHAT MEASUREMENT SHOWED (and corrected an assumption)
 * `estimateWeeklyFlow` takes the MEDIAN weekly outflow (quantile 0.5). A card paid once a
 * month lands in roughly 11 of 51 weeks (~22%), which is far below the median, so those
 * weeks are discarded as outliers. The payoff was therefore never "averaged into" the
 * daily baseline as first assumed — it was almost entirely ABSENT from the forecast. That
 * makes charging it on the due date a strict improvement rather than a reallocation.
 *
 * The exclusion matcher is kept as insurance, not because it moves the median at this
 * cadence. It is load-bearing the moment payoffs land in more than half the weeks (a
 * weekly autopay, or two cards on different cycles), and it can only ever REMOVE payoff
 * weeks, never add outflow. The tests below assert both facts explicitly so nobody later
 * reads the matcher as decorative and deletes it.
 *
 * Uses `assembleCapacity` (the SHIPPED path) with a synthetic ledger, so the arithmetic
 * proven here is the arithmetic the page runs.
 */

import {
  assembleCapacity,
  buildWeeklyFlows,
  estimateWeeklyFlow,
  type LedgerRow,
} from '../lib/spending-capacity-service'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const TODAY = '2026-08-03'
const CHECKING = 'South Lafourche Bank Checking ending 2268'
const CARD = 'American Express ending 0-73009'
const MATCHER = 'AMEX EPAYMENT'

const accounts = [
  { account_name: CHECKING, account_type: 'Checking', current_balance: 16791.29 },
  { account_name: CARD, account_type: 'Credit Card', current_balance: 9948.13 },
]

/**
 * A year of weekly history: steady sales in, steady costs out, plus card payoffs on a
 * configurable cadence.
 *
 * `weeklyPayoff` exists to cross the median threshold on purpose. At monthly cadence the
 * median cannot see the payoff; at weekly cadence it must.
 */
function buildLedger(opts: {
  inflowPerDay: number
  outflowPerDay: number
  weeklyPayoff: boolean
}): LedgerRow[] {
  const rows: LedgerRow[] = []
  const start = new Date(Date.UTC(2025, 7, 4)) // Mon 2025-08-04

  for (let w = 0; w < 51; w++) {
    for (let d = 0; d < 5; d++) {
      const dt = new Date(start)
      dt.setUTCDate(start.getUTCDate() + w * 7 + d)
      const date = dt.toISOString().slice(0, 10)
      if (date >= TODAY) continue
      rows.push({
        date,
        description: `SQ${date.replace(/-/g, '').slice(2)}`,
        amount: opts.inflowPerDay,
        type: 'income',
        accountName: CHECKING,
      })
      rows.push({
        date,
        description: 'Supplier invoice',
        amount: opts.outflowPerDay,
        type: 'expense',
        accountName: CHECKING,
      })
      // A weekly payoff, so payoff weeks become the majority and the median moves.
      if (opts.weeklyPayoff && d === 2) {
        rows.push({
          date,
          description: 'AMEX EPAYMENT ACH PMT',
          amount: 2000,
          type: 'expense',
          accountName: CHECKING,
        })
      }
    }
  }

  if (!opts.weeklyPayoff) {
    // One payoff per month, on the 19th — the real pattern in this ledger.
    for (const m of [
      '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02',
      '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
    ]) {
      rows.push({
        date: `${m}-19`,
        description: 'AMEX EPAYMENT ACH PMT',
        amount: 8000,
        type: 'expense',
        accountName: CHECKING,
      })
    }
  }

  return rows
}

const rows = buildLedger({ inflowPerDay: 2600, outflowPerDay: 1500, weeklyPayoff: false })

const base = {
  accounts,
  rows,
  obligations: [] as never[],
  payments: [] as never[],
  minCashReserve: 15000,
  today: TODAY,
}

const card = {
  accountName: CARD,
  closedAt: null,
  balanceOwed: 9948.13,
  statementDueDate: '2026-08-18',
  paymentDescriptionMatch: MATCHER,
}

// ===========================================================================
// 1. The mechanism: does the matcher actually remove payoff weeks?
//    Asserted on the weekly series, where the effect is visible, rather than
//    through a median that discards those weeks anyway.
// ===========================================================================
{
  const withPayoffs = buildWeeklyFlows(rows, { operatingAccounts: [CHECKING], today: TODAY })
  const excluded = buildWeeklyFlows(rows, {
    operatingAccounts: [CHECKING],
    today: TODAY,
    excludeMatchers: [MATCHER],
  })

  const payoffWeeks = withPayoffs.filter((w) => w.outflow > 7500).length
  const stillThere = excluded.filter((w) => w.outflow > 7500).length

  check('history contains payoff weeks to begin with', payoffWeeks > 0, `${payoffWeeks}`)
  check('the matcher removes every payoff week', stillThere === 0, `${stillThere} remain`)
  check(
    'the matcher never increases any week',
    excluded.every((w, i) => w.outflow <= withPayoffs[i].outflow),
  )
}

// ===========================================================================
// 2. The median is blind to a monthly payoff. Documented, not assumed.
// ===========================================================================
{
  const withPayoffs = estimateWeeklyFlow(
    buildWeeklyFlows(rows, { operatingAccounts: [CHECKING], today: TODAY }),
  )
  const excluded = estimateWeeklyFlow(
    buildWeeklyFlows(rows, {
      operatingAccounts: [CHECKING],
      today: TODAY,
      excludeMatchers: [MATCHER],
    }),
  )
  check(
    'a MONTHLY payoff does not move the median baseline (it was never in it)',
    withPayoffs.typicalOutflow === excluded.typicalOutflow,
    `${withPayoffs.typicalOutflow} vs ${excluded.typicalOutflow}`,
  )
}

// ===========================================================================
// 3. When payoffs ARE the majority of weeks, the matcher becomes load-bearing
//    and MUST lower the baseline. This is the double count the matcher prevents.
// ===========================================================================
{
  const weekly = buildLedger({ inflowPerDay: 2600, outflowPerDay: 1500, weeklyPayoff: true })
  const inflated = estimateWeeklyFlow(
    buildWeeklyFlows(weekly, { operatingAccounts: [CHECKING], today: TODAY }),
  )
  const fixed = estimateWeeklyFlow(
    buildWeeklyFlows(weekly, {
      operatingAccounts: [CHECKING],
      today: TODAY,
      excludeMatchers: [MATCHER],
    }),
  )
  check(
    'with frequent payoffs the matcher lowers the baseline (prevents double count)',
    fixed.typicalOutflow < inflated.typicalOutflow,
    `${fixed.typicalOutflow} vs ${inflated.typicalOutflow}`,
  )
  check(
    'and the reduction is the payoff amount, not an arbitrary shift',
    Math.abs(inflated.typicalOutflow - fixed.typicalOutflow - 2000) < 0.01,
    `delta ${inflated.typicalOutflow - fixed.typicalOutflow}`,
  )
}

// ===========================================================================
// 4. The payoff is charged once, on the due date, at full balance.
// ===========================================================================
const after = assembleCapacity({ ...base, cards: [card], horizonDays: 30, nearTermDays: 7 })

const dueDay = after.result.days.find((d) => d.date === '2026-08-18')
check('the due date is inside the projection', dueDay !== undefined)

const cardItems = dueDay?.items.filter((i) => i.label.includes('statement payment')) ?? []
check('the payoff appears exactly once on the due date', cardItems.length === 1, `got ${cardItems.length}`)
check(
  'the payoff is charged at full balance',
  Math.abs((cardItems[0]?.amount ?? 0) - 9948.13) < 0.01,
  String(cardItems[0]?.amount),
)

const otherDays = after.result.days.filter(
  (d) => d.date !== '2026-08-18' && d.items.some((i) => i.label.includes('statement payment')),
)
check('the payoff appears on no other day', otherDays.length === 0, `${otherDays.length} other days`)

// ===========================================================================
// 5. Two windows, two questions. A distant payoff must not zero the headline,
//    but it must still be projected.
// ===========================================================================
console.log('\ncash-positive business:')
console.log(`  safe to spend today : $${after.result.safeToSpendToday.toFixed(2)}`)
console.log(`  near-term low (7d)  : $${after.result.nearTermLowestBalance.toFixed(2)}`)
console.log(`  horizon low (${after.result.horizonDays}d)  : $${after.result.lowestBalance.toFixed(2)} on ${after.result.lowestBalanceDate}`)
console.log(`  breaches reserve    : ${after.result.breachesReserve}`)

check(
  'the horizon low is never above the near-term low',
  after.result.lowestBalance <= after.result.nearTermLowestBalance,
)
check(
  'a distant payoff does not zero out what is spendable today',
  after.result.safeToSpendToday > 0,
  `got ${after.result.safeToSpendToday}`,
)
check('the projection spans the configured horizon', after.result.days.length >= 30, `${after.result.days.length}`)
check('the near-term window is reported', after.result.nearTermDays === 7)

// In a business earning more than it spends, the balance climbs and the low point is
// today. "No breach" is the CORRECT answer here — asserting a breach would be asserting
// a bug. The breach case gets its own fixture below.
check(
  'a cash-positive business reports no breach',
  after.result.breachesReserve === false,
  `shortfall ${after.result.reserveShortfall}`,
)

// ===========================================================================
// 6. THE POINT OF THE FEATURE: when cash is tight, the payoff must trip the
//    reserve warning — and it must be the payoff that does it.
// ===========================================================================
{
  // Costs nearly match income, so the balance is flat and the payoff is what breaks it.
  const tightRows = buildLedger({ inflowPerDay: 2600, outflowPerDay: 2550, weeklyPayoff: false })
  const tight = {
    accounts: [
      { account_name: CHECKING, account_type: 'Checking', current_balance: 20288.0 },
      { account_name: CARD, account_type: 'Credit Card', current_balance: 9948.13 },
    ],
    rows: tightRows,
    obligations: [] as never[],
    payments: [] as never[],
    minCashReserve: 15000,
    today: TODAY,
  }

  const withoutCard = assembleCapacity({ ...tight, horizonDays: 30, nearTermDays: 7 })
  const withCard = assembleCapacity({ ...tight, cards: [card], horizonDays: 30, nearTermDays: 7 })

  console.log('\ncash-tight business (the case this feature exists for):')
  console.log(`  card NOT forecast : low $${withoutCard.result.lowestBalance.toFixed(2)} on ${withoutCard.result.lowestBalanceDate}, breach ${withoutCard.result.breachesReserve}`)
  console.log(`  card forecast     : low $${withCard.result.lowestBalance.toFixed(2)} on ${withCard.result.lowestBalanceDate}, breach ${withCard.result.breachesReserve}, shortfall $${withCard.result.reserveShortfall.toFixed(2)}`)
  console.log(`  spendable today   : $${withoutCard.result.safeToSpendToday.toFixed(2)} -> $${withCard.result.safeToSpendToday.toFixed(2)}`)

  check(
    'forecasting the payoff lowers the horizon low point',
    withCard.result.lowestBalance < withoutCard.result.lowestBalance,
    `${withCard.result.lowestBalance} vs ${withoutCard.result.lowestBalance}`,
  )
  // Deliberately "on or after", not "exactly on". The payoff is what pushes the trough
  // past the reserve, but the actual minimum can fall a few days LATER: once cash has
  // dropped, a weekend (no card settlements, so no inflow that day) digs slightly deeper.
  // Asserting the exact due date would be asserting a coincidence of this fixture's
  // day-of-week profile, and would fail for a real ledger without anything being wrong.
  check(
    'the low point moves to the due date or later',
    withCard.result.lowestBalanceDate >= '2026-08-18',
    withCard.result.lowestBalanceDate,
  )
  check(
    'and it is the payoff that moved it (it was earlier without the card)',
    withCard.result.lowestBalanceDate > withoutCard.result.lowestBalanceDate,
    `${withCard.result.lowestBalanceDate} vs ${withoutCard.result.lowestBalanceDate}`,
  )
  check(
    'the reserve breach is now visible',
    withCard.result.breachesReserve === true && withoutCard.result.breachesReserve === false,
    `with ${withCard.result.breachesReserve}, without ${withoutCard.result.breachesReserve}`,
  )
  check('the shortfall is a real amount', withCard.result.reserveShortfall > 0)
  check(
    'the headline still answers "today", not "the 18th"',
    withCard.result.safeToSpendToday === withoutCard.result.safeToSpendToday,
    `${withCard.result.safeToSpendToday} vs ${withoutCard.result.safeToSpendToday}`,
  )
}

// ===========================================================================
// 7. Horizon auto-extension: a due date beyond the horizon is still projected.
// ===========================================================================
{
  const far = assembleCapacity({
    ...base,
    cards: [{ ...card, statementDueDate: '2026-09-25' }],
    horizonDays: 14,
    nearTermDays: 7,
  })
  const hit = far.result.days.find((d) => d.date === '2026-09-25')
  check('horizon stretches to include a distant due date', hit !== undefined)
  check(
    'the distant payoff is charged there',
    (hit?.items ?? []).some((i) => i.label.includes('statement payment')),
  )
}

// ===========================================================================
// 8. Gaps are stated, never silent.
// ===========================================================================
{
  const blocked = assembleCapacity({
    ...base,
    cards: [{ ...card, statementDueDate: null }],
    horizonDays: 30,
    nearTermDays: 7,
  })
  check('a card with no due date is reported as blocked', blocked.blockedCardPayments.length === 1)
  check('a blocked card adds no dated outflow', blocked.cardPayments.length === 0)

  const nullBalance = assembleCapacity({
    ...base,
    cards: [{ ...card, balanceOwed: null }],
    horizonDays: 30,
    nearTermDays: 7,
  })
  check(
    'an unrecorded balance is blocked, not forecast as $0',
    nullBalance.blockedCardPayments.length === 1 && nullBalance.cardPayments.length === 0,
  )
  check(
    'and it says the balance is missing',
    nullBalance.blockedCardPayments[0]?.blockedReason === 'balance not recorded',
    nullBalance.blockedCardPayments[0]?.blockedReason ?? 'none',
  )

  const closed = assembleCapacity({
    ...base,
    cards: [{ ...card, closedAt: '2025-12-27' }],
    horizonDays: 30,
    nearTermDays: 7,
  })
  check(
    'a closed card is neither forecast nor reported as a gap',
    closed.cardPayments.length === 0 && closed.blockedCardPayments.length === 0,
  )
}

// ===========================================================================
// 9. Omitting cards reproduces the previous behaviour exactly.
// ===========================================================================
{
  const legacy = assembleCapacity(base)
  const before = assembleCapacity({ ...base, horizonDays: 30, nearTermDays: 7 })
  check(
    'omitting cards preserves the previous baseline',
    legacy.estimate.typicalOutflow === before.estimate.typicalOutflow,
  )
  check('omitting cards yields a 7-day projection', legacy.result.days.length === 7)
  check('omitting cards forecasts no card payments', legacy.cardPayments.length === 0)
}

// ===========================================================================
// The horizon is BOUNDED by its setting, and never stretched to reach a far-off bill.
//
// Both bugs below shipped and were caught in the browser, not by a script.
//
// (1) An earlier version grew the span until it covered the furthest dated outflow. The
//     real ledger holds obligations months ahead, so a 30-day forecast quietly became a
//     90-day one, and a median weekly estimate compounded over 13 weeks reported a
//     -$10,773 low point with the advice "hold back at least $25,773" — more than the
//     business had in the bank.
// ===========================================================================
{
  const withFarBill = assembleCapacity({
    ...base,
    horizonDays: 30,
    nearTermDays: 7,
    // A real obligation 120 days out, well past the horizon.
    obligations: [
      { id: 'far-1', effectiveDueDate: '2026-12-01', amount: 1500, vendorName: 'Distant bill' },
    ],
  })

  check(
    'a bill beyond the horizon does not extend the projection',
    withFarBill.result.days.length === 30,
    `got ${withFarBill.result.days.length} days`,
  )
  check(
    'reported horizonDays matches the days actually produced',
    withFarBill.result.horizonDays === withFarBill.result.days.length,
  )
  check(
    'the low point stays inside the horizon',
    withFarBill.result.lowestBalanceDate <= '2026-09-01',
    `low point ${withFarBill.result.lowestBalanceDate}`,
  )
  // The advice must be actionable: never tell the owner to hold back more than exists.
  check(
    'reserve shortfall is not larger than starting cash',
    withFarBill.result.reserveShortfall <= withFarBill.cashOnHand,
    `shortfall ${withFarBill.result.reserveShortfall} vs cash ${withFarBill.cashOnHand}`,
  )
}

// ===========================================================================
// (2) Near-term and horizon breaches are tracked INDEPENDENTLY.
//
//     The panel used to infer "is the breach near-term?" by testing the horizon low
//     point's DATE against the window. When cash dipped under the reserve inside the week
//     AND fell further weeks later, that test said "not near-term" and the urgent warning
//     disappeared behind the distant one.
// ===========================================================================
{
  // A reserve high enough that the ordinary weekly trough breaches it immediately,
  // combined with the card payoff landing later — so BOTH windows breach.
  const both = assembleCapacity({
    ...base,
    horizonDays: 30,
    nearTermDays: 7,
    minCashReserve: 16500,
  })

  check(
    'a near-term breach is reported on its own flag',
    both.result.breachesReserveNearTerm === true,
    `nearTermLow ${both.result.nearTermLowestBalance}`,
  )
  check(
    'a near-term breach also counts as a horizon breach',
    both.result.breachesReserve === true,
  )
  check(
    'the near-term low point is dated inside the window',
    both.result.nearTermLowestBalanceDate <= both.result.days[6].date,
    `dated ${both.result.nearTermLowestBalanceDate}`,
  )
  check(
    'the near-term shortfall is measured against the near-term low',
    Math.abs(
      both.result.nearTermReserveShortfall -
        (16500 - both.result.nearTermLowestBalance),
    ) < 0.02,
  )
  // The horizon low can only be as low or lower than the window's.
  check(
    'horizon low point is never above the near-term low point',
    both.result.lowestBalance <= both.result.nearTermLowestBalance,
  )

  // The inverse: a clean week with a later cliff must NOT set the near-term flag, or the
  // panel would claim "nothing spare to spend this week" while the headline offers money.
  const laterOnly = assembleCapacity({ ...base, horizonDays: 30, nearTermDays: 7 })
  check(
    'a breach only beyond the window leaves the near-term flag clear',
    laterOnly.result.breachesReserveNearTerm === false,
    `nearTermLow ${laterOnly.result.nearTermLowestBalance}`,
  )
  check(
    'no near-term breach means no near-term shortfall',
    laterOnly.result.nearTermReserveShortfall === 0,
  )
}

// ===========================================================================
// Forecast items are TAGGED, so the UI can list real payments without repeating the
// spread estimate once per day. Matching on the label text instead let a rename silently
// reclassify the estimate as a known payment.
// ===========================================================================
{
  const tagged = assembleCapacity({ ...base, horizonDays: 30, nearTermDays: 7 })
  const all = tagged.result.days.flatMap((d) => d.items)

  check('every forecast item carries a kind', all.every((i) => i.kind === 'dated' || i.kind === 'estimate'))
  check(
    'the spread baseline is tagged as an estimate',
    all
      .filter((i) => i.label === 'Day-to-day running costs')
      .every((i) => i.kind === 'estimate'),
  )
  const cardItems = all.filter((i) => i.label.includes('statement payment'))
  check('a card payment is tagged as dated', cardItems.length > 0 && cardItems.every((i) => i.kind === 'dated'))
  // The estimate recurs daily; dated items must be far rarer, which is the whole reason
  // the UI filters on the tag.
  const estimates = all.filter((i) => i.kind === 'estimate').length
  check('the estimate appears on every projected day', estimates === tagged.result.days.length)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
