/**
 * THROWAWAY PROBE (deleted before commit).
 *
 * Two questions that decide the design:
 *  1. Is a longer horizon viable, or is this business steadily cash-negative so the
 *     trough is always the final day (making the horizon length the whole answer)?
 *  2. Does the MEDIAN weekly outflow already contain the Amex payoff? Payoffs land
 *     once a month, so the median week may not include one at all — in which case
 *     adding a dated payment is not a double-count and excluding it changes nothing.
 */
import { createClient } from '@supabase/supabase-js'
import {
  buildWeeklyFlows,
  estimateWeeklyFlow,
  formatDate,
  assembleCapacity,
  type LedgerRow,
} from '../lib/spending-capacity-service'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function allRows() {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('financial_transactions')
      .select('transaction_date, description, amount, transaction_type, account_name')
      .is('deleted_at', null)
      .not('account_name', 'is', null)
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    if (!data?.length) break
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}

async function main() {
  const today = formatDate(new Date())

  const [{ data: accounts }, { data: settingRows }, raw] = await Promise.all([
    supabase
      .from('bank_accounts')
      .select(
        'account_name, account_type, current_balance, statement_balance, statement_due_date, credit_limit, closed_at',
      ),
    supabase.from('business_settings').select('setting_key, value'),
    allRows(),
  ])

  // Settings are KEY/VALUE ROWS, not columns. Reading them as columns and `?? 0`-ing
  // the miss is the exact trap that once reported a $0 reserve. Assert instead.
  const settings = new Map((settingRows ?? []).map((r: any) => [r.setting_key, Number(r.value)]))
  const reserve = settings.get('min_cash_reserve')
  if (!Number.isFinite(reserve)) throw new Error('min_cash_reserve missing — refusing to guess')

  const rows: LedgerRow[] = raw.map((r) => ({
    date: String(r.transaction_date ?? '').slice(0, 10),
    description: r.description ?? '',
    amount: Number(r.amount ?? 0),
    type: r.transaction_type ?? '',
    accountName: r.account_name ?? '',
  }))

  console.log('today:', today, ' reserve:', reserve)

  const operatingAccounts = [
    ...new Set(
      rows
        .map((r) => r.accountName)
        .filter((n) => n && !/amex|american express|credit|card|loan/i.test(n)),
    ),
  ]

  // ---- Q2: does the median week contain a payoff? ----
  const MATCHER = 'AMEX EPAYMENT'
  const payoffs = rows.filter(
    (r) => r.description.toUpperCase().includes(MATCHER) && operatingAccounts.includes(r.accountName),
  )
  console.log(`\n--- payoffs matching "${MATCHER}" (correct matcher) ---`)
  console.log('count:', payoffs.length)
  for (const p of payoffs) console.log(' ', p.date, p.amount.toFixed(2), '|', p.description)

  const weeksWith = new Set(payoffs.map((p) => p.date))
  console.log('distinct payoff dates:', weeksWith.size)

  const before = estimateWeeklyFlow(buildWeeklyFlows(rows, { operatingAccounts, today }))
  const after = estimateWeeklyFlow(
    buildWeeklyFlows(rows, { operatingAccounts, today, excludeMatchers: [MATCHER] }),
  )
  console.log('\n--- median weekly outflow, before vs after excluding payoffs ---')
  console.log('weeksObserved      ', before.weeksObserved)
  console.log('typicalOutflow BEFORE', before.typicalOutflow)
  console.log('typicalOutflow AFTER ', after.typicalOutflow)
  console.log('difference           ', (before.typicalOutflow - after.typicalOutflow).toFixed(2))
  console.log('typicalInflow        ', before.typicalInflow)
  console.log('cautiousInflow       ', before.cautiousInflow)
  console.log('NET typical (in-out) ', (after.typicalInflow - after.typicalOutflow).toFixed(2))
  console.log('NET cautious(in-out) ', (after.cautiousInflow - after.typicalOutflow).toFixed(2))

  // ---- Q1: shipped 7-day result, with the REAL reserve ----
  const asm = assembleCapacity({
    accounts: accounts ?? [],
    rows,
    obligations: [],
    payments: [],
    minCashReserve: reserve as number,
    today,
  })
  console.log('\n--- shipped assembly (7-day, real reserve) ---')
  console.log('cashOnHand      ', asm.cashOnHand)
  console.log('safeToSpendToday', asm.result.safeToSpendToday)
  console.log('lowestBalance   ', asm.result.lowestBalance, 'on', asm.result.lowestBalanceDate)
  console.log('breachesReserve ', asm.result.breachesReserve)

  // ---- Q1: trajectory with the card payment added on its due date ----
  const card = (accounts ?? []).find((a: any) =>
    /amex|american express/i.test(String(a.account_name)),
  ) as any
  const due = card?.statement_due_date
  const owed = Number(card?.current_balance ?? 0)
  console.log(`\n--- card: owed ${owed.toFixed(2)} due ${due} ---`)

  const baselineDaily = after.typicalOutflow / 7
  for (const horizon of [7, 14, 21, 30, 45]) {
    let cautious = asm.cashOnHand
    let typical = asm.cashOnHand
    let minC = Infinity
    let minCDay = ''
    let firstBreach = ''
    for (let i = 0; i < horizon; i++) {
      const d = new Date(Date.parse(today + 'T00:00:00Z') + i * 86400000)
      const iso = d.toISOString().slice(0, 10)
      const dow = ((d.getUTCDay() + 6) % 7) + 1
      const dated = iso === due ? owed : 0
      cautious = cautious + after.cautiousInflow * (asm.shares[dow] ?? 0) - baselineDaily - dated
      typical = typical + after.typicalInflow * (asm.shares[dow] ?? 0) - baselineDaily - dated
      if (cautious < minC) {
        minC = cautious
        minCDay = iso
      }
      if (!firstBreach && cautious < (reserve as number)) firstBreach = iso
    }
    console.log(
      `horizon ${String(horizon).padStart(2)}d: cautiousTrough ${minC.toFixed(2)} on ${minCDay} | ` +
        `safeToSpend ${Math.max(0, minC - (reserve as number)).toFixed(2)} | ` +
        `typicalEnd ${typical.toFixed(2)} | firstBreach ${firstBreach || 'none'}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
