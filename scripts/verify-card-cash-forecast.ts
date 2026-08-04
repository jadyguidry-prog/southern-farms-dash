/**
 * Checks that charging a card payoff on its DUE DATE does not double-count it.
 *
 * This is the one failure mode that makes the feature worse than doing nothing. Past
 * payoffs are already inside the median weekly baseline. Adding a dated payoff WITHOUT
 * removing them from that baseline charges the same ~$9.9k twice — the forecast would
 * then understate cash and the owner would be told to hold back money that is not needed.
 *
 * Uses `assembleCapacity` (the SHIPPED path) with a synthetic ledger, so the arithmetic
 * proven here is the arithmetic the page runs. A test that re-implements the assembly
 * proves nothing about the page.
 */

import { assembleCapacity, type LedgerRow } from '../lib/spending-capacity-service'

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
 * A year of weekly history: steady sales in, steady costs out, plus ONE card payoff a
 * month on the 19th — the real pattern in this ledger.
 */
function buildLedger(): LedgerRow[] {
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
        amount: 2600,
        type: 'income',
        accountName: CHECKING,
      })
      rows.push({
        date,
        description: 'Supplier invoice',
        amount: 1500,
        type: 'expense',
        accountName: CHECKING,
      })
    }
  }

  // One payoff per month, on the 19th.
  for (const m of ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']) {
    rows.push({
      date: `${m}-19`,
      description: 'AMEX EPAYMENT ACH PMT',
      amount: 8000,
      type: 'expense',
      accountName: CHECKING,
    })
  }

  return rows
}

const rows = buildLedger()

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

// ---------------------------------------------------------------------------
// Baseline: no cards passed. Must behave exactly as before the feature.
// ---------------------------------------------------------------------------
const before = assembleCapacity({ ...base, horizonDays: 30, nearTermDays: 7 })

// With the card forecast + its history excluded from the baseline.
const after = assembleCapacity({
  ...base,
  cards: [card],
  horizonDays: 30,
  nearTermDays: 7,
})

// Deliberately WRONG configuration: forecast the payoff but leave history in the
// baseline. This is the double count, and it must be measurably worse.
const doubleCounted = assembleCapacity({
  ...base,
  cards: [{ ...card, paymentDescriptionMatch: null }],
  horizonDays: 30,
  nearTermDays: 7,
})

console.log('weekly outflow baseline:')
console.log(`  no card wired      : $${before.estimate.typicalOutflow.toFixed(2)}`)
console.log(`  card wired (fixed) : $${after.estimate.typicalOutflow.toFixed(2)}`)
console.log(`  matcher missing    : $${doubleCounted.estimate.typicalOutflow.toFixed(2)}`)

// ---------------------------------------------------------------------------
// The core assertion: wiring the card REDUCES the estimated baseline, because the
// historical payoffs are no longer inside it.
// ---------------------------------------------------------------------------
check(
  'excluding payoff history lowers the weekly baseline',
  after.estimate.typicalOutflow < before.estimate.typicalOutflow,
  `${after.estimate.typicalOutflow} vs ${before.estimate.typicalOutflow}`,
)

check(
  'a missing matcher leaves the baseline inflated (the double count)',
  doubleCounted.estimate.typicalOutflow > after.estimate.typicalOutflow,
  `${doubleCounted.estimate.typicalOutflow} vs ${after.estimate.typicalOutflow}`,
)

// The payoff appears exactly once, on its due date.
const dueDay = after.result.days.find((d) => d.date === '2026-08-18')
check('the due date is inside the projection', dueDay !== undefined)

const cardItems = dueDay?.items.filter((i) => i.label.includes('statement payment')) ?? []
check('the payoff appears exactly once on the due date', cardItems.length === 1, `got ${cardItems.length}`)
check(
  'the payoff is charged at full balance',
  Math.abs((cardItems[0]?.amount ?? 0) - 9948.13) < 0.01,
  String(cardItems[0]?.amount),
)

// It must NOT appear on any other day.
const otherDays = after.result.days.filter(
  (d) => d.date !== '2026-08-18' && d.items.some((i) => i.label.includes('statement payment')),
)
check('the payoff appears on no other day', otherDays.length === 0, `${otherDays.length} other days`)

// ---------------------------------------------------------------------------
// The headline must NOT be crushed by a payment three weeks out, and the breach
// warning MUST still fire. Two questions, two windows.
// ---------------------------------------------------------------------------
console.log('\nheadline vs horizon:')
console.log(`  safe to spend today   : $${after.result.safeToSpendToday.toFixed(2)}`)
console.log(`  near-term low (7d)    : $${after.result.nearTermLowestBalance.toFixed(2)}`)
console.log(`  horizon low (${after.result.horizonDays}d)    : $${after.result.lowestBalance.toFixed(2)} on ${after.result.lowestBalanceDate}`)
console.log(`  breaches reserve      : ${after.result.breachesReserve}`)
console.log(`  shortfall             : $${after.result.reserveShortfall.toFixed(2)}`)

check(
  'the headline is solved against the near-term window, not the horizon',
  after.result.nearTermLowestBalance >= after.result.lowestBalance,
)
check(
  'a distant payoff does not zero out what is spendable today',
  after.result.safeToSpendToday > 0,
  `got ${after.result.safeToSpendToday}`,
)
check(
  'the projection spans the configured horizon',
  after.result.days.length >= 30,
  `${after.result.days.length} days`,
)
check('the near-term window is reported', after.result.nearTermDays === 7)

// ---------------------------------------------------------------------------
// Horizon auto-extension: a due date beyond the configured horizon must still be
// projected, or the cliff is invisible again.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// A card with no due date must not silently vanish from the reckoning.
// ---------------------------------------------------------------------------
{
  const blocked = assembleCapacity({
    ...base,
    cards: [{ ...card, statementDueDate: null }],
    horizonDays: 30,
    nearTermDays: 7,
  })
  check('a card with no due date is reported as blocked', blocked.blockedCardPayments.length === 1)
  check('a blocked card adds no dated outflow', blocked.cardPayments.length === 0)
  check(
    'a blocked card does NOT have its history excluded',
    blocked.estimate.typicalOutflow === before.estimate.typicalOutflow,
    `${blocked.estimate.typicalOutflow} vs ${before.estimate.typicalOutflow}`,
  )
}

// ---------------------------------------------------------------------------
// Omitting cards entirely must reproduce the old behaviour exactly.
// ---------------------------------------------------------------------------
{
  const legacy = assembleCapacity(base)
  check(
    'omitting cards preserves the previous baseline',
    legacy.estimate.typicalOutflow === before.estimate.typicalOutflow,
  )
  check('omitting cards yields a 7-day projection', legacy.result.days.length === 7)
  check('omitting cards forecasts no card payments', legacy.cardPayments.length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
