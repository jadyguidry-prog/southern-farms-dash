/**
 * Model what-if scenarios against the September cash trough.
 *
 * Reuses the SHIPPED `assembleCapacity` rather than re-deriving the projection, so a
 * scenario cannot quietly disagree with the /cash-flow page about how a forecast is built.
 * Only the INPUTS are varied — an obligation's date, a card payoff amount — which is also
 * how the real world would change them.
 *
 * Two honesty rules this script must keep:
 *
 * 1. It loads obligations with the service key, while the page reads them under the owner's
 *    cookie. Those can differ. So the baseline is ASSERTED against the figures the page
 *    actually rendered; if they diverge the output is labelled a bound rather than passed off
 *    as what the owner will see.
 * 2. It must not invent numbers. Amex's true minimum payment is NOT recorded anywhere in this
 *    app, so partial-payment scenarios are expressed as amounts the owner would choose, never
 *    as "the minimum".
 */
import { createClient } from '@supabase/supabase-js'
import { fetchAllPages } from '../lib/paginate'
import { resolveNextDueDate } from '../lib/health'
import {
  addDays,
  assembleCapacity,
  formatDate,
  parseDate,
  weekStart,
  type LedgerRow,
} from '../lib/spending-capacity-service'

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

/**
 * Figures read off the rendered /cash-flow page, used to anchor the baseline.
 *
 * `capturedOn` is the date those figures were read. The script itself reads the clock the
 * same way the page does rather than pinning a date — pinning is what made the first run
 * diverge, because the sandbox clock had already rolled to the 11th.
 */
const PAGE = {
  capturedOn: '2026-08-11',
  cashOnHand: 21_536.35,
  minCashReserve: 15_000,
  safeToSpendToday: 0,
  typicalTrough: -8_121,
  cautiousTrough: -17_046,
  troughDate: '2026-09-06',
  availableCredit: 20_000,
}

const usd = (n: number) =>
  (n < 0 ? '-' : '') +
  '$' +
  Math.abs(Math.round(n)).toLocaleString('en-US')

type Obligation = {
  id: string
  obligationName: string
  vendorName: string
  amount: number
  dueDate: string
  nextDueDate: string
  recurring: boolean
  frequency: string
  selfScheduled: boolean
  invoiceDate: string | null
  paymentTermsDays: number | null
  status: string
  active: boolean
  effectiveDueDate: string
}

type Card = {
  accountName: string
  closedAt: string | null
  balanceOwed: number | null
  statementDueDate: string | null
  paymentDescriptionMatch: string | null
}

type Inputs = Awaited<ReturnType<typeof loadInputs>>

async function loadInputs() {
  // Same clock read as lib/spending-capacity-data.ts, so the horizon lines up with the page.
  const today = formatDate(new Date())
  if (today !== PAGE.capturedOn) {
    console.log(
      `  NOTE: page anchors were captured on ${PAGE.capturedOn}, clock is now ${today}.\n` +
        '        A mismatch here is expected drift, not necessarily a bug.',
    )
  }

  const [{ data: accounts }, { data: settingsRows }, { data: obligationRows }, { data: paymentRows }] =
    await Promise.all([
      db
        .from('bank_accounts')
        .select(
          'account_name, account_type, current_balance, credit_limit, closed_at, statement_due_date, payment_description_match',
        ),
      db.from('business_settings').select('setting_key, value'),
      db.from('cash_obligations').select('*').order('due_date', { ascending: true }),
      db.from('obligation_payments').select('*').neq('status', 'void'),
    ])

  const setting = (key: string) => {
    const row = (settingsRows ?? []).find((r) => r.setting_key === key)
    // Never `?? 0` a settings read: a failed query would become a plausible wrong answer.
    if (!row) throw new Error(`setting ${key} is missing — refusing to guess a value`)
    return Number(row.value)
  }

  const ledgerRows = await fetchAllPages<{
    transaction_date: string | null
    description: string | null
    amount: number | string | null
    transaction_type: string | null
    account_name: string | null
  }>(
    (from, to) =>
      db
        .from('financial_transactions')
        .select('transaction_date, description, amount, transaction_type, account_name')
        .is('deleted_at', null)
        .not('account_name', 'is', null)
        .order('transaction_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    'model-cash-scenarios ledger',
  )

  const rows: LedgerRow[] = (ledgerRows ?? []).map((r) => ({
    date: String(r.transaction_date ?? '').slice(0, 10),
    description: r.description ?? '',
    amount: Number(r.amount ?? 0),
    type: r.transaction_type ?? '',
    accountName: r.account_name ?? '',
  }))

  const obligations: Obligation[] = (obligationRows ?? [])
    .map((o) => ({
      id: o.id,
      obligationName: o.obligation_name,
      vendorName: o.vendor_name ?? '',
      amount: Number(o.amount),
      dueDate: o.due_date ?? '',
      nextDueDate: o.next_due_date ?? '',
      recurring: Boolean(o.recurring),
      frequency: o.frequency ?? '',
      selfScheduled: Boolean(o.self_scheduled),
      invoiceDate: o.invoice_date ?? null,
      paymentTermsDays: o.payment_terms_days == null ? null : Number(o.payment_terms_days),
      status: o.status ?? 'Pending',
      // The column is `active`, not `is_active`. Reading the wrong name made every row look
      // active because `undefined !== false`.
      active: o.active ?? true,
    }))
    // Mirrors lib/queries.ts exactly: only active, unpaid obligations reach the forecast.
    .filter((o) => o.status !== 'Paid' && o.active !== false)
    // resolveNextDueDate takes a DATE. Passing a string made `d < today` compare a number
    // against NaN, which is always false, so recurring bills never rolled forward and the
    // script under-charged the forecast.
    .map((o) => ({
      ...o,
      effectiveDueDate: resolveNextDueDate(o as never, parseDate(today)) ?? '',
    }))

  const payments = (paymentRows ?? []).map((r) => ({
    id: r.id,
    obligationId: r.obligation_id,
    amount: Number(r.amount) || 0,
    paymentDate: (r.payment_date ?? '').slice(0, 10),
    paymentMethod: r.payment_method === 'ach' ? ('ach' as const) : ('check' as const),
    checkNumber: r.check_number,
    checkWritten: r.check_written !== false,
    bankAccountId: r.bank_account_id,
    status:
      r.status === 'cleared'
        ? ('cleared' as const)
        : r.status === 'void'
          ? ('void' as const)
          : ('outstanding' as const),
    clearedDate: r.cleared_date ? r.cleared_date.slice(0, 10) : null,
    clearedTransactionId: r.cleared_transaction_id,
    memo: r.memo ?? '',
    createdAt: r.created_at ?? '',
    payeeName: r.payee_name ?? '',
    payeeVendorId: r.payee_vendor_id ?? null,
    purpose: r.purpose ?? '',
  }))

  // Cards, from the same records the card panel reads. A line of credit has no statement
  // cycle and must not be forecast as a dated payoff.
  const cards: Card[] = (accounts ?? [])
    .filter((a) => /card|amex|american express/i.test(`${a.account_type ?? ''} ${a.account_name ?? ''}`))
    .map((a) => ({
      accountName: String(a.account_name ?? ''),
      closedAt: a.closed_at ?? null,
      balanceOwed: a.current_balance == null ? null : Number(a.current_balance),
      statementDueDate: a.statement_due_date ?? null,
      paymentDescriptionMatch: a.payment_description_match ?? null,
    }))

  return {
    accounts: accounts ?? [],
    rows,
    obligations,
    payments,
    cards,
    today,
    minCashReserve: setting('min_cash_reserve'),
    horizonDays: setting('cash_forecast_horizon_days'),
    nearTermDays: setting('cash_near_term_days'),
  }
}

function run(input: Inputs) {
  return assembleCapacity({
    accounts: input.accounts as never,
    rows: input.rows,
    obligations: input.obligations as never,
    payments: input.payments as never,
    minCashReserve: input.minCashReserve,
    today: input.today,
    cards: input.cards as never,
    horizonDays: input.horizonDays,
    nearTermDays: input.nearTermDays,
  })
}

/** Shift an obligation's due date by n days, matched by vendor/name substring. */
function shift(input: Inputs, match: RegExp, days: number, limit = Infinity): Inputs {
  let moved = 0
  return {
    ...input,
    obligations: input.obligations.map((o) => {
      const label = `${o.vendorName} ${o.obligationName}`
      if (moved >= limit || !match.test(label) || !o.effectiveDueDate) return o
      moved++
      return { ...o, effectiveDueDate: addDays(o.effectiveDueDate, days) }
    }),
  }
}

/** Pay only part of a card statement, by lowering the balance the forecast charges. */
function payCard(input: Inputs, match: RegExp, amount: number): Inputs {
  return {
    ...input,
    cards: input.cards.map((c) =>
      match.test(c.accountName) ? { ...c, balanceOwed: amount } : c,
    ),
  }
}

/**
 * Model a SUSTAINED lift in weekly takings.
 *
 * Adds `perWeek` of extra receipts to every complete week already in the ledger. Because
 * median(x + c) === median(x) + c and the same holds for the lower quartile, this raises the
 * typical AND cautious weekly inflow by exactly `perWeek` — which is what "my sales run
 * higher from now on" actually means to the forecast.
 *
 * Deliberately dated inside weeks the ledger already covers, so the partial-week detection
 * added earlier sees no new coverage spans and the week count cannot change.
 *
 * This is extra CASH COLLECTED, not extra sales rung up. The conversion between the two is
 * the owner's gross margin, which is not quotable in this business, so the two are reported
 * separately and never silently equated.
 */
function addWeeklyReceipts(input: Inputs, perWeek: number): Inputs {
  if (perWeek === 0) return input
  const account = String(
    (input.accounts as { account_name?: string; account_type?: string }[]).find(
      (a) => !/credit|card|line of credit/i.test(String(a.account_type ?? '')),
    )?.account_name ?? '',
  )
  if (!account) throw new Error('no operating account found — refusing to model blind')

  const weeks = new Set(
    input.rows
      .filter((r) => r.accountName === account && r.date)
      .map((r) => weekStart(r.date)),
  )

  const synthetic: LedgerRow[] = [...weeks].map((wk) => ({
    // Wednesday of each covered week: comfortably inside the span, never on an edge.
    date: addDays(wk, 2),
    description: 'SCENARIO extra receipts',
    amount: perWeek,
    type: 'income',
    accountName: account,
  }))

  return { ...input, rows: [...input.rows, ...synthetic] }
}

/** Model a lump sum collected today, by raising the operating account's balance. */
function injectCash(input: Inputs, amount: number): Inputs {
  let done = false
  return {
    ...input,
    accounts: (input.accounts as { account_type?: string; current_balance?: number }[]).map(
      (a) => {
        if (done || /credit|card|line of credit/i.test(String(a.account_type ?? ''))) return a
        done = true
        return { ...a, current_balance: Number(a.current_balance ?? 0) + amount }
      },
    ) as never,
  }
}

/** Smallest value on `grid` where the trough clears `floor`, or null if none does. */
function solve(
  make: (v: number) => Inputs,
  pick: (r: ReturnType<typeof run>['result']) => number,
  floor: number,
  grid: number[],
) {
  for (const v of grid) if (pick(run(make(v)).result) >= floor) return v
  return null
}

async function main() {
  const base = await loadInputs()
  const baseline = run(base)

  console.log('='.repeat(78))
  console.log('BASELINE VALIDATION — does this script reproduce the rendered page?')
  console.log('='.repeat(78))

  const checks: [string, number, number][] = [
    ['cash on hand', baseline.cashOnHand, PAGE.cashOnHand],
    ['safe to spend today', baseline.result.safeToSpendToday, PAGE.safeToSpendToday],
    ['typical trough', baseline.result.typicalLowestBalance, PAGE.typicalTrough],
    ['cautious trough', baseline.result.lowestBalance, PAGE.cautiousTrough],
  ]
  let faithful = baseline.result.lowestBalanceDate === PAGE.troughDate
  for (const [label, got, want] of checks) {
    const ok = Math.abs(got - want) <= 2
    if (!ok) faithful = false
    console.log(
      `  ${ok ? 'OK  ' : 'DIFF'} ${label.padEnd(22)} script ${usd(got).padStart(10)}   page ${usd(want).padStart(10)}`,
    )
  }
  console.log(
    `  ${baseline.result.lowestBalanceDate === PAGE.troughDate ? 'OK  ' : 'DIFF'} trough date            script ${baseline.result.lowestBalanceDate}   page ${PAGE.troughDate}`,
  )
  console.log()
  console.log(
    faithful
      ? '  => Baseline matches the page. Scenario deltas below are what the owner would see.'
      : '  => Baseline DIVERGES from the page (service key sees different obligations than the\n' +
        '     owner cookie). Treat every figure below as an indicative BOUND, not the page.',
  )

  console.log()
  console.log('  weekly estimate: typical in ' + usd(baseline.estimate.typicalInflow) +
    ' | cautious in ' + usd(baseline.estimate.cautiousInflow) +
    ' | typical out ' + usd(baseline.estimate.typicalOutflow) +
    ' | weeks ' + baseline.estimate.weeksObserved)
  console.log('  (page showed: typical in $14,413 | cautious in $12,023)')

  console.log()
  console.log('='.repeat(78))
  console.log('DATED OBLIGATIONS INSIDE THE HORIZON (what actually causes the trough)')
  console.log('='.repeat(78))
  let cum = 0
  for (const o of [...baseline.datedOutflows].sort((a, b) => a.date.localeCompare(b.date))) {
    cum += o.amount
    console.log(
      '  ' +
        o.date +
        '  ' +
        String(o.label).slice(0, 34).padEnd(36) +
        usd(o.amount).padStart(9) +
        '   cumulative ' +
        usd(cum).padStart(9),
    )
  }
  console.log('  ' + 'TOTAL dated'.padEnd(48) + usd(cum).padStart(9))

  const scenarios: { name: string; note: string; input: Inputs }[] = [
    { name: 'A. Do nothing', note: 'every bill paid in full on its current date', input: base },
    {
      name: 'B. Amex: pay half now',
      note: 'rest carried to next statement, interest not modelled',
      input: payCard(base, /amex|american express/i, 4_974),
    },
    {
      name: 'C. Amex: pay $3,000 now',
      note: 'a chosen partial — Amex real minimum is not recorded in the app',
      input: payCard(base, /amex|american express/i, 3_000),
    },
    {
      name: 'D. Sysco: move one run +7d',
      note: 'one delivery shifted a week later on terms',
      input: shift(base, /sysco/i, 7, 1),
    },
    {
      name: 'E. Sysco: move both runs +7d',
      note: 'both deliveries shifted a week',
      input: shift(base, /sysco/i, 7),
    },
    {
      name: 'E2. Sysco: move both runs +21d',
      note: 'far enough to land PAST the trough date — the distinction that matters',
      input: shift(base, /sysco/i, 21),
    },
    {
      name: 'F. Amex half + one Sysco +7d',
      note: 'the two biggest levers together',
      input: shift(payCard(base, /amex|american express/i, 4_974), /sysco/i, 7, 1),
    },
    {
      name: 'G. Amex $3,000 + both Sysco +7d',
      note: 'most aggressive deferral modelled',
      input: shift(payCard(base, /amex|american express/i, 3_000), /sysco/i, 7),
    },
    {
      name: 'H. Amex $3,000 + both Sysco +21d',
      note: 'the only combination where both levers actually clear the trough',
      input: shift(payCard(base, /amex|american express/i, 3_000), /sysco/i, 21),
    },
    {
      name: 'I. Amex $0 + both Sysco +21d',
      note: 'the theoretical floor: pay nothing on the card and push all Sysco past Sep 6',
      input: shift(payCard(base, /amex|american express/i, 0), /sysco/i, 21),
    },
  ]

  console.log()
  console.log('='.repeat(78))
  console.log('SCENARIOS — 30-day low point, and whether the reserve survives')
  console.log('='.repeat(78))
  console.log(
    '  scenario'.padEnd(36) +
      'typical low'.padStart(13) +
      'cautious low'.padStart(14) +
      '  verdict',
  )

  for (const s of scenarios) {
    const r = run(s.input).result
    const typical = r.typicalLowestBalance
    const cautious = r.lowestBalance
    const verdict =
      cautious >= base.minCashReserve
        ? 'reserve intact even in a bad week'
        : cautious >= 0
          ? 'below reserve, but never overdrawn'
          : typical >= 0
            ? 'overdrawn only in a bad week'
            : 'still overdrawn on the expected path'
    console.log(
      '  ' +
        s.name.padEnd(34) +
        usd(typical).padStart(13) +
        usd(cautious).padStart(14) +
        '  ' +
        verdict,
    )
    console.log('    ' + s.note)
  }

  // ---- How much CAN go on the card before the trough turns negative? ----
  //
  // Solved rather than guessed, and reported for both the expected and the bad week, since
  // a ceiling that only holds on a good week is not a ceiling worth acting on.
  console.log()
  console.log('='.repeat(78))
  console.log('AMEX CEILING — largest statement payment that keeps the trough above $0')
  console.log('='.repeat(78))
  for (const [label, pick] of [
    ['expected week', (r: ReturnType<typeof run>['result']) => r.typicalLowestBalance],
    ['bad week', (r: ReturnType<typeof run>['result']) => r.lowestBalance],
  ] as const) {
    let best: number | null = null
    // Coarse sweep is enough: the owner pays in whole dollars, not to the cent.
    for (let pay = 0; pay <= 9_948; pay += 100) {
      if (pick(run(payCard(base, /amex|american express/i, pay)).result) >= 0) best = pay
    }
    console.log(
      '  ' +
        label.padEnd(16) +
        (best === null
          ? 'NO payment amount works — even paying $0 on the card leaves a shortfall'
          : `pay at most ${usd(best)} of the ${usd(9_948)} statement`),
    )
  }

  // ---- Can extra sales close this instead? ----
  const troughDate = baseline.result.lowestBalanceDate
  const daysToTrough = Math.round(
    (parseDate(troughDate).getTime() - parseDate(base.today).getTime()) / 86_400_000,
  )
  const weeksToTrough = daysToTrough / 7

  console.log()
  console.log('='.repeat(78))
  console.log('CAN EXTRA SALES CLOSE IT? — solved, not guessed')
  console.log('='.repeat(78))
  console.log(
    `  Trough is ${troughDate}: ${daysToTrough} days out, ~${weeksToTrough.toFixed(1)} weeks of trading.`,
  )
  console.log()

  // Prove the lift model does what it claims before quoting any "+$X/week" answer: a lift of
  // L must raise the typical AND cautious weekly inflow by exactly L, and must not change how
  // many weeks are observed. Quantiles are shift-invariant, so anything else means the
  // synthetic rows landed somewhere they shouldn't have.
  {
    const L = 1_000
    const lifted = run(addWeeklyReceipts(base, L)).estimate
    const failures = [
      ['typical inflow', lifted.typicalInflow, baseline.estimate.typicalInflow + L],
      ['cautious inflow', lifted.cautiousInflow, baseline.estimate.cautiousInflow + L],
      ['weeks observed', lifted.weeksObserved, baseline.estimate.weeksObserved],
      ['typical outflow', lifted.typicalOutflow, baseline.estimate.typicalOutflow],
    ].filter(([, got, want]) => Math.abs(Number(got) - Number(want)) > 1)

    if (failures.length > 0) {
      for (const [label, got, want] of failures) {
        console.log(`  LIFT MODEL BROKEN: ${label} is ${got}, expected ${want}`)
      }
      throw new Error('the sustained-lift model is not a clean shift — refusing to quote it')
    }
    console.log(
      `  (lift model verified: +${usd(L)}/wk moves typical and cautious inflow by exactly ${usd(L)},` +
        ' leaves outflow and week count untouched)',
    )
  }

  const weekGrid = Array.from({ length: 121 }, (_, i) => i * 250)
  const lumpGrid = Array.from({ length: 141 }, (_, i) => i * 250)

  console.log('  SUSTAINED lift — extra cash collected EVERY week from now on:')
  for (const [label, pick] of [
    ['expected week', (r: ReturnType<typeof run>['result']) => r.typicalLowestBalance],
    ['bad week', (r: ReturnType<typeof run>['result']) => r.lowestBalance],
  ] as const) {
    for (const [floorLabel, floor] of [
      ['stay solvent ($0)', 0],
      [`keep reserve (${usd(base.minCashReserve)})`, base.minCashReserve],
    ] as const) {
      const need = solve((v) => addWeeklyReceipts(base, v), pick, floor, weekGrid)
      console.log(
        '    ' +
          label.padEnd(15) +
          floorLabel.padEnd(26) +
          (need === null
            ? 'not reachable within +$30,000/wk'
            : `+${usd(need)}/week  (about ${usd(need * weeksToTrough)} total before ${troughDate})`),
      )
    }
  }

  console.log()
  console.log('  ONE-OFF collection — a single lump sum banked today:')
  for (const [label, pick] of [
    ['expected week', (r: ReturnType<typeof run>['result']) => r.typicalLowestBalance],
    ['bad week', (r: ReturnType<typeof run>['result']) => r.lowestBalance],
  ] as const) {
    for (const [floorLabel, floor] of [
      ['stay solvent ($0)', 0],
      [`keep reserve (${usd(base.minCashReserve)})`, base.minCashReserve],
    ] as const) {
      const need = solve((v) => injectCash(base, v), pick, floor, lumpGrid)
      console.log(
        '    ' +
          label.padEnd(15) +
          floorLabel.padEnd(26) +
          (need === null ? 'not reachable within $35,000' : usd(need) + ' collected now'),
      )
    }
  }

  // The realistic ask: sales lift needed ON TOP OF the bill levers, which is the combination
  // the owner would actually run. Quoting a sales target that ignores the levers overstates
  // how much trading has to change.
  console.log()
  console.log('  COMBINED with scenario H (Amex held to $3,000 + all Sysco +21d):')
  const withLevers = shift(payCard(base, /amex|american express/i, 3_000), /sysco/i, 21)
  for (const [label, pick] of [
    ['expected week', (r: ReturnType<typeof run>['result']) => r.typicalLowestBalance],
    ['bad week', (r: ReturnType<typeof run>['result']) => r.lowestBalance],
  ] as const) {
    for (const [floorLabel, floor] of [
      ['stay solvent ($0)', 0],
      [`keep reserve (${usd(base.minCashReserve)})`, base.minCashReserve],
    ] as const) {
      const need = solve((v) => addWeeklyReceipts(withLevers, v), pick, floor, weekGrid)
      console.log(
        '    ' +
          label.padEnd(15) +
          floorLabel.padEnd(26) +
          (need === null
            ? 'not reachable within +$30,000/wk'
            : need === 0
              ? 'already clear — no extra sales needed'
              : `+${usd(need)}/week of extra cash`),
      )
    }
  }

  // Cash collected is not sales rung up. Margin is not quotable in this business, so the
  // conversion is shown as a range instead of being asserted as one number.
  const needSolvent = solve(
    (v) => addWeeklyReceipts(base, v),
    (r) => r.typicalLowestBalance,
    0,
    weekGrid,
  )
  if (needSolvent !== null && needSolvent > 0) {
    console.log()
    console.log('  What that lift means in SALES (cash collected / gross margin):')
    console.log(
      `    to net +${usd(needSolvent)}/week of cash you must ring up roughly:`,
    )
    for (const margin of [0.2, 0.3, 0.4, 0.5, 1]) {
      const label = margin === 1 ? 'pure margin, no added cost' : `at ${Math.round(margin * 100)}% margin`
      console.log(
        '      ' + label.padEnd(30) + '+' + usd(needSolvent / margin) + '/week of extra sales',
      )
    }
    console.log(
      `    for scale: typical weekly takings are ${usd(baseline.estimate.typicalInflow)}.`,
    )
  }

  console.log()
  console.log('='.repeat(78))
  console.log('CREDIT LINE COVER (borrowing, not cash — never added to the forecast)')
  console.log('='.repeat(78))
  for (const s of scenarios) {
    const r = run(s.input).result
    const needTypical = Math.max(0, -r.typicalLowestBalance)
    const needCautious = Math.max(0, -r.lowestBalance)
    console.log(
      '  ' +
        s.name.padEnd(34) +
        'draw needed: typical ' +
        usd(needTypical).padStart(8) +
        ' | cautious ' +
        usd(needCautious).padStart(8) +
        (needCautious > PAGE.availableCredit ? '   EXCEEDS the line' : ''),
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
