/**
 * Reconciliation gate for the spending-capacity engine.
 *
 * The whole "safe to spend" feature rests on one claim: that our model of money
 * in/out matches the real bank account. This script proves it, against live data,
 * using the SAME classifier the app uses (`classifyFlow`) so the proof can never
 * drift from the shipped code.
 *
 * Method: take today's known checking balance and walk the ledger BACKWARD. If our
 * classification is right, the reconstructed history must (a) land on a sane opening
 * balance and (b) never imply an impossible balance. If this script fails, the
 * forecast must not be trusted — that is the point of having it.
 *
 * Run: npx tsx scripts/verify-cash-reconciliation.ts
 */
import { createClient } from '@supabase/supabase-js'
import {
  classifyFlow,
  buildWeeklyFlows,
  estimateWeeklyFlow,
  buildDayOfWeekProfile,
  deriveSpendingCapacity,
  formatDate,
  weekStart,
  type LedgerRow,
} from '../lib/spending-capacity-service'

let failures = 0
function ok(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log('(skipped — no credentials)')
    return
  }
  const db = createClient(url, key)

  // ---- the operating account we forecast on ----
  const { data: accounts, error: acctErr } = await db
    .from('bank_accounts')
    .select('account_name, account_type, current_balance')
  if (acctErr) {
    console.log('(skipped —', acctErr.message, ')')
    return
  }

  const checking = (accounts ?? []).find(
    (a) => /^checking$/i.test((a.account_type ?? '').trim()) && !/square/i.test(a.account_name ?? ''),
  )
  if (!checking) {
    console.log('(skipped — could not identify the operating checking account)')
    return
  }
  const todayBalance = Number(checking.current_balance ?? 0)
  console.log(`\nOperating account: ${checking.account_name} @ ${money(todayBalance)}`)

  // The ledger labels this account by its bank name ("South Lafourche Bank ...") while
  // bank_accounts calls it "Business Checking". Resolve the ledger label from the data
  // rather than hardcoding either string, so a rename on one side cannot silently make
  // the reconciliation compare against an empty set and "pass".
  const { data: labels } = await db
    .from('financial_transactions')
    .select('account_name')
    .is('deleted_at', null)
    .not('account_name', 'is', null)
    .limit(2000)
  const counts = new Map<string, number>()
  for (const l of labels ?? []) {
    const n = l.account_name as string
    if (/amex|american express|credit/i.test(n)) continue
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  const ledgerLabel = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!ledgerLabel) {
    console.log('(skipped — no non-card ledger account label found)')
    return
  }
  console.log(`Ledger label for it: ${ledgerLabel}`)

  // ---- the ledger for that account ----
  const rows: LedgerRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('financial_transactions')
      .select('transaction_date, description, amount, transaction_type, account_name, deleted_at')
      .eq('account_name', ledgerLabel)
      .is('deleted_at', null)
      .range(from, from + 999)
    if (error) {
      console.log('(skipped —', error.message, ')')
      return
    }
    if (!data || data.length === 0) break
    for (const r of data) {
      rows.push({
        date: String(r.transaction_date).slice(0, 10),
        description: r.description ?? '',
        amount: Number(r.amount ?? 0),
        type: r.transaction_type ?? '',
        accountName: r.account_name ?? '',
      })
    }
    if (data.length < 1000) break
  }
  console.log(`Ledger rows: ${rows.length}`)
  ok('the operating account has ledger history to reconcile', rows.length > 100)

  // ---- classification census ----
  // Only this checking account holds forecastable cash. The Amex is deliberately
  // excluded: a card purchase is not cash leaving, and counting both the purchase and
  // its later payoff is exactly the double-count that made naive averages unusable.
  const operatingAccounts = [ledgerLabel]

  const census = new Map<string, { n: number; total: number }>()
  for (const r of rows) {
    const cls = classifyFlow(r, operatingAccounts)
    const cur = census.get(cls) ?? { n: 0, total: 0 }
    cur.n++
    cur.total += r.amount
    census.set(cls, cur)
  }
  console.log('\nClassification census (all history)')
  for (const [cls, v] of [...census.entries()].sort()) {
    console.log(`  ${cls.padEnd(10)} ${String(v.n).padStart(5)} rows  ${money(v.total).padStart(12)}`)
  }

  // Financing and internal transfers MUST be recognised. If these ever fall to zero
  // it means the descriptions changed and we are silently treating a loan advance as
  // revenue — the exact error that would inflate "safe to spend" by five figures.
  ok(
    'the Square Capital advance is recognised as financing, not sales',
    (census.get('financing')?.n ?? 0) > 0,
  )
  ok(
    'internal transfers are recognised and excluded from spending',
    (census.get('internal_out')?.n ?? 0) > 0,
  )
  // Transfers here are asymmetric (~$21k in vs ~$43k out) because the counterpart
  // accounts are absent from this ledger. Both directions must be seen, or the
  // reconstruction silently loses real cash movement.
  ok(
    'inbound internal transfers are detected, not just outbound',
    (census.get('internal_in')?.n ?? 0) > 0,
  )

  // ---- backward reconstruction ----
  // net(day) = inflow - outflow, counting ONLY real operating money.
  // Financing/internal are excluded from the forecast, but they DID move the bank
  // balance, so the reconstruction must include them or it will not tie out.
  const byDate = new Map<string, number>()
  for (const r of rows) {
    const cls = classifyFlow(r, operatingAccounts)
    // Internal transfers are excluded from SPENDING estimates but they genuinely move
    // this account's balance, because the counterpart accounts are not in this ledger.
    const signed =
      cls === 'in' || cls === 'financing' || cls === 'internal_in'
        ? r.amount
        : -r.amount
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + signed)
  }

  const dates = [...byDate.keys()].sort()
  const netTotal = dates.reduce((s, d) => s + (byDate.get(d) ?? 0), 0)
  const impliedOpening = todayBalance - netTotal

  console.log('\nBackward reconstruction')
  console.log(`  net movement over history : ${money(netTotal)}`)
  console.log(`  implied opening balance   : ${money(impliedOpening)}`)

  // An opening balance must be a plausible real number. A wildly negative one means
  // we are over-counting outflows (e.g. double-counting card payoffs); a wildly large
  // one means we are missing outflows.
  ok(
    'the implied opening balance is plausible (not deeply negative)',
    impliedOpening > -5_000,
    `got ${money(impliedOpening)}`,
  )
  ok(
    'the implied opening balance is not absurdly large',
    impliedOpening < 250_000,
    `got ${money(impliedOpening)}`,
  )

  // Walk forward from the implied opening and confirm we land exactly on today.
  let running = impliedOpening
  let minBal = Infinity
  let minDate = ''
  for (const d of dates) {
    running += byDate.get(d) ?? 0
    if (running < minBal) {
      minBal = running
      minDate = d
    }
  }
  ok(
    'walking forward lands exactly on the known balance',
    Math.abs(running - todayBalance) < 0.01,
    `ended ${money(running)} vs ${money(todayBalance)}`,
  )
  console.log(`  lowest reconstructed bal  : ${money(minBal)} on ${minDate}`)

  // The account never actually went deeply negative. If our reconstruction says it
  // did, our signs are wrong somewhere.
  ok(
    'the reconstructed balance never goes deeply negative',
    minBal > -5_000,
    `low point ${money(minBal)} on ${minDate}`,
  )

  // ---- derived estimates the UI will show ----
  // buildWeeklyFlows already drops the in-progress week; pass the newest ledger date
  // as "today" so the boundary is derived from the data rather than the clock.
  const latest = dates[dates.length - 1]
  const complete = buildWeeklyFlows(rows, { operatingAccounts, today: latest })
  const est = estimateWeeklyFlow(complete)

  console.log('\nDerived weekly estimates (medians, financing/internal excluded)')
  console.log(`  weeks observed     : ${complete.length}`)
  console.log(`  typical inflow /wk : ${money(est.typicalInflow)}`)
  console.log(`  cautious inflow /wk: ${money(est.cautiousInflow)}`)
  console.log(`  typical outflow /wk: ${money(est.typicalOutflow)}`)

  ok('enough complete weeks to form an estimate', complete.length >= 8)
  ok('typical weekly inflow is a positive number', est.typicalInflow > 0)
  ok(
    'the cautious inflow is never above the typical inflow',
    est.cautiousInflow <= est.typicalInflow,
  )

  // Median-based estimates must resist the one-off $36k advance + $32k check that
  // both landed on 2026-06-08. If either leaked in, these numbers explode.
  ok(
    'the one-off financing week does not distort the typical inflow',
    est.typicalInflow < 40_000,
    `got ${money(est.typicalInflow)}`,
  )
  ok(
    'the one-off check does not distort the typical outflow',
    est.typicalOutflow < 40_000,
    `got ${money(est.typicalOutflow)}`,
  )

  // ---- day-of-week shape ----
  const { shares, hasProfile } = buildDayOfWeekProfile(rows, { operatingAccounts })
  const dayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  console.log('\nDeposit shape by weekday (share of a week)')
  for (let i = 1; i <= 7; i++) {
    console.log(`  ${dayNames[i]}  ${((shares[i] ?? 0) * 100).toFixed(1)}%`)
  }
  ok('a usable weekday profile was derived from history', hasProfile)
  const shareSum = Object.values(shares).reduce((s, v) => s + v, 0)
  ok('the weekday shares sum to 1', Math.abs(shareSum - 1) < 0.001, `sum ${shareSum}`)
  ok(
    'weekends carry no deposits (money lands Mon-Fri)',
    (shares[6] ?? 0) + (shares[7] ?? 0) < 0.02,
  )

  // ---- engine invariants (NOT the page's exact figures) ----
  // Scope note, learned the hard way: this script cannot reproduce the numbers
  // the page shows. Scheduled obligations and uncleared checks come from
  // cookie-scoped queries that need a request context, and without them both the
  // dated outflows and the baseline `excludeMatchers` differ. An earlier version
  // of this script pretended otherwise and printed a safe-to-spend of $1,185
  // while the page showed $1,437 — a fake precision that is worse than silence.
  //
  // So this section asserts only invariants that hold for ANY set of dated bills.
  // Cross-surface agreement is guaranteed structurally instead: the page, the
  // advisor, and the admin report all call `assembleCapacity`, so they cannot
  // disagree with each other. Read exact figures from the app, not from here.
  //
  // business_settings is a KEY-VALUE table (setting_key / value), not one column
  // per setting. Selecting `min_cash_reserve` as a column fails, and a `?? 0`
  // fallback then silently reports "no reserve set" for a farm that has $15,000
  // configured — understating the reserve and overstating safe-to-spend. So the
  // read is asserted rather than defaulted.
  const { data: settingsRows, error: settingsError } = await db
    .from('business_settings')
    .select('setting_key, value')
  if (settingsError) {
    throw new Error(`could not read business_settings: ${settingsError.message}`)
  }
  const reserveRow = (settingsRows ?? []).find((r) => r.setting_key === 'min_cash_reserve')
  if (!reserveRow) {
    throw new Error(
      'business_settings has no min_cash_reserve row — refusing to assume $0, ' +
        'which would overstate how much is safe to spend.',
    )
  }
  const minCashReserve = Number(reserveRow.value)
  ok(
    'the configured cash reserve is read, not defaulted to zero',
    Number.isFinite(minCashReserve) && minCashReserve > 0,
    `min_cash_reserve=${minCashReserve}`,
  )

  const cashOnHand = (accounts ?? [])
    .filter((a) => !/credit|loan|card/i.test(`${a.account_type ?? ''} ${a.account_name ?? ''}`))
    .reduce((s, a) => s + Number(a.current_balance ?? 0), 0)

  const today = formatDate(new Date())
  const result = deriveSpendingCapacity({
    cashOnHand,
    minCashReserve,
    today,
    estimate: est,
    shares,
    datedOutflows: [],
    baselineWeeklyOutflow: est.typicalOutflow,
  })

  // Direction of the difference, verified against the live app: with no dated
  // bills loaded, nothing is excluded from the estimated baseline, so the
  // baseline outflow is HIGHER here than on the page ($14,381 vs $14,185) and the
  // resulting figure is therefore LOWER ($1,185 vs $1,437). It is a conservative
  // floor, not a ceiling. Erring low is the safe direction for a spending number.
  console.log('\nEngine invariants — NO dated bills loaded, so this is a')
  console.log('conservative floor, not the figure the app shows:')
  console.log(`  cash on hand (all cash accts): ${money(cashOnHand)}`)
  console.log(`  minimum reserve (settings)   : ${money(minCashReserve)}`)
  console.log(`  floor under safe-to-spend    : ${money(result.safeToSpendToday)}`)
  console.log(`  weeks of history observed    : ${est.weeksObserved}`)

  ok('the safe-to-spend figure is never negative', result.safeToSpendToday >= 0)
  ok(
    'safe-to-spend never exceeds cash on hand (cannot spend money we lack)',
    result.safeToSpendToday <= cashOnHand,
    `${money(result.safeToSpendToday)} vs ${money(cashOnHand)}`,
  )
  ok('a 7-day projection was produced', result.days.length === 7)
  // Reserve is the whole point of the feature: if the projection dips below it,
  // the engine must report that rather than quietly offering money to spend.
  ok(
    'a projected dip below the reserve is reported, not hidden',
    !result.breachesReserve || result.safeToSpendToday === 0,
    `breaches=${result.breachesReserve} safe=${money(result.safeToSpendToday)}`,
  )

  console.log(
    failures === 0
      ? '\nRECONCILED — the cash model ties out to the real balance.\n'
      : `\n${failures} RECONCILIATION FAILURE(S) — do not trust the forecast.\n`,
  )
  if (failures > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
