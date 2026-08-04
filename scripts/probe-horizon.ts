/**
 * Runs the REAL ledger through the SHIPPED engine to show what the forecast now says.
 *
 * SCOPE, stated honestly: this reads the database with the service key and calls
 * `assembleCapacity` directly. It reproduces the engine's arithmetic exactly, but it does
 * NOT prove what renders on the page — the page reads settings and card exposure through
 * cookie-scoped loaders this script cannot use. Treat the output as the engine's answer
 * for these inputs, not as a screenshot of the owner's screen.
 */

import { createClient } from '@supabase/supabase-js'
import { assembleCapacity, formatDate, type LedgerRow } from '../lib/spending-capacity-service'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

function fmt(n: number) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Paged read: a single select caps at 1000 rows and would silently truncate history. */
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
        'account_name, account_type, current_balance, statement_due_date, closed_at, payment_description_match',
      ),
    supabase.from('business_settings').select('setting_key, value'),
    allRows(),
  ])

  // Settings are KEY/VALUE ROWS, not columns. Never `?? 0` a settings read — a failed
  // query becomes a plausible-looking wrong number. Assert instead.
  const settings = new Map((settingRows ?? []).map((r: any) => [r.setting_key, Number(r.value)]))
  for (const key of ['min_cash_reserve', 'cash_forecast_horizon_days', 'cash_near_term_days']) {
    if (!Number.isFinite(settings.get(key))) throw new Error(`setting ${key} missing — refusing to guess`)
  }
  const minCashReserve = settings.get('min_cash_reserve')!
  const horizonDays = settings.get('cash_forecast_horizon_days')!
  const nearTermDays = settings.get('cash_near_term_days')!

  const rows: LedgerRow[] = raw.map((r) => ({
    date: String(r.transaction_date ?? '').slice(0, 10),
    description: r.description ?? '',
    amount: Number(r.amount ?? 0),
    type: r.transaction_type ?? '',
    accountName: r.account_name ?? '',
  }))

  const cards = (accounts ?? [])
    .filter((a: any) => /credit|card|amex|american express/i.test(String(a.account_type ?? '') + String(a.account_name ?? '')))
    .map((a: any) => ({
      accountName: a.account_name as string,
      closedAt: (a.closed_at as string | null) ?? null,
      // NOTE: `current_balance` is NOT NULL DEFAULT 0, so a genuine 0 and "never entered"
      // are indistinguishable here. The shipped page uses getCardExposure, which knows the
      // difference. This probe takes the column at face value and says so.
      balanceOwed: Number(a.current_balance ?? 0),
      statementDueDate: (a.statement_due_date as string | null) ?? null,
      paymentDescriptionMatch: (a.payment_description_match as string | null) ?? null,
    }))

  console.log(`today=${today}  reserve=${fmt(minCashReserve)}  horizon=${horizonDays}d  window=${nearTermDays}d`)
  console.log(`ledger rows: ${rows.length}`)
  for (const c of cards) {
    console.log(
      `card: ${c.accountName} owed=${fmt(c.balanceOwed)} due=${c.statementDueDate ?? 'NOT RECORDED'}` +
        ` closed=${c.closedAt ?? 'open'} matcher=${c.paymentDescriptionMatch ?? 'none'}`,
    )
  }

  const base = {
    accounts: (accounts ?? []).map((a: any) => ({
      account_name: a.account_name as string,
      account_type: a.account_type as string,
      current_balance: Number(a.current_balance ?? 0),
    })),
    rows,
    obligations: [] as never[],
    payments: [] as never[],
    minCashReserve,
    today,
  }

  // BEFORE: exactly the old behaviour — 7-day window, no cards passed.
  const before = assembleCapacity(base)
  const after = assembleCapacity({ ...base, cards, horizonDays, nearTermDays })

  console.log('\n--- BEFORE (7-day window, card payment invisible) ---')
  console.log(`cash on hand       : ${fmt(before.cashOnHand)}`)
  console.log(`safe to spend      : ${fmt(before.result.safeToSpendToday)}`)
  console.log(`low point          : ${fmt(before.result.lowestBalance)} on ${before.result.lowestBalanceDate}`)
  console.log(`breaches reserve   : ${before.result.breachesReserve}`)
  console.log(`days projected     : ${before.result.days.length}`)

  console.log('\n--- AFTER (payoff charged on its due date) ---')
  console.log(`safe to spend      : ${fmt(after.result.safeToSpendToday)}`)
  console.log(`near-term low (${after.result.nearTermDays}d): ${fmt(after.result.nearTermLowestBalance)}`)
  console.log(`horizon low (${after.result.horizonDays}d)  : ${fmt(after.result.lowestBalance)} on ${after.result.lowestBalanceDate}`)
  console.log(`breaches reserve   : ${after.result.breachesReserve}  shortfall ${fmt(after.result.reserveShortfall)}`)
  console.log(`weekly outflow est : ${fmt(before.estimate.typicalOutflow)} -> ${fmt(after.estimate.typicalOutflow)}`)

  for (const p of after.cardPayments) {
    console.log(`forecast payoff    : ${p.accountName} ${fmt(p.amount)} on ${p.dueDate}${p.isEstimatedDate ? ' (date rolled forward)' : ''}`)
  }
  for (const p of after.blockedCardPayments) {
    console.log(`NOT forecast       : ${p.accountName} — ${p.blockedReason}`)
  }

  const due = after.result.days.filter((d) =>
    d.items.some((i) => i.label.includes('statement payment')),
  )
  console.log('\ndays carrying a card payment:')
  if (due.length === 0) console.log('  (none)')
  for (const d of due) {
    console.log(
      `  ${d.date}  out ${fmt(d.moneyOut)}  balance ${fmt(d.cautiousBalance)}` +
        `${d.breachesReserve ? '  << UNDER RESERVE' : ''}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
