/**
 * Smoke test: run the Growth Planner against the REAL database and print what the
 * owner would actually see. This is a bound-check, not a page test — it calls the
 * same service the page calls, but service-role queries can differ from the
 * cookie-scoped ones a logged-in page makes, so treat the output as indicative and
 * confirm the real numbers in the browser.
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing Supabase env. Source /vercel/share/.env.project first.')
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

async function main() {
  const { data: modes, error: modeErr } = await sb
    .from('growth_risk_modes')
    .select('*')
    .order('sort_order')
  if (modeErr) throw new Error(`risk modes: ${modeErr.message}`)

  console.log('=== Risk modes (all thresholds are DATA, not hardcoded) ===')
  for (const m of modes ?? []) {
    console.log(
      `  ${m.mode_key.padEnd(13)} reserve_floor=${String(m.reserve_floor_pct).padStart(3)}%  ` +
        `min_days_cash=${String(m.min_days_cash).padStart(2)}  ` +
        `loc=${m.loc_allowed ? `yes(<=${m.max_loc_utilization_pct}%)` : 'no '}  ` +
        `default=${m.is_default}`,
    )
  }

  const { data: accts, error: acctErr } = await sb
    .from('bank_accounts')
    .select('account_name, account_type, current_balance, credit_limit, available_credit, last_updated')
    .order('account_type')
  if (acctErr) throw new Error(`accounts: ${acctErr.message}`)

  const deposit = ['Checking', 'Savings', 'Cash']
  const cash = (accts ?? [])
    .filter((a) => deposit.includes(a.account_type))
    .reduce((s, a) => s + Number(a.current_balance), 0)
  const drawn = (accts ?? [])
    .filter((a) => !deposit.includes(a.account_type))
    .reduce((s, a) => s + Number(a.current_balance), 0)
  const avail = (accts ?? [])
    .filter((a) => !deposit.includes(a.account_type))
    .reduce((s, a) => s + Number(a.available_credit ?? 0), 0)

  console.log('\n=== Accounts ===')
  for (const a of accts ?? []) {
    console.log(
      `  ${String(a.account_name).slice(0, 34).padEnd(34)} ${String(a.account_type).padEnd(14)}` +
        ` bal=${Number(a.current_balance).toFixed(2).padStart(10)}` +
        ` avail=${Number(a.available_credit ?? 0).toFixed(2).padStart(10)}` +
        ` updated=${a.last_updated ?? 'NEVER'}`,
    )
  }
  console.log(`\n  cash(deposit only) = $${cash.toFixed(2)}`)
  console.log(`  credit drawn       = $${drawn.toFixed(2)}`)
  console.log(`  available credit   = $${avail.toFixed(2)}`)

  const { data: settings } = await sb
    .from('business_settings')
    .select('setting_key, value, unit')
    // The reserve key is `min_cash_reserve`, NOT `cash_reserve_target`. I first wrote
    // the latter here and it came back silently absent — the exact shape of the bug
    // that once reported a $0 reserve. The service asserts on this key rather than
    // defaulting, so a typo fails loudly instead of inventing headroom.
    .in('setting_key', [
      'min_cash_reserve',
      'days_cash_target',
      'account_data_stale_days',
      'growth_horizon_months',
    ])
  console.log('\n=== Relevant settings ===')
  for (const s of settings ?? []) {
    console.log(`  ${String(s.setting_key).padEnd(26)} ${s.value} ${s.unit ?? ''}`)
  }

  // Staleness of the hand-entered balances — the thing that most undermines trust.
  const staleDays = Number(
    (settings ?? []).find((s) => s.setting_key === 'account_data_stale_days')?.value ?? 14,
  )
  const today = new Date()
  console.log(`\n=== Balance freshness (threshold ${staleDays}d) ===`)
  for (const a of accts ?? []) {
    if (!a.last_updated) {
      console.log(`  ${String(a.account_name).slice(0, 34).padEnd(34)} NEVER UPDATED`)
      continue
    }
    const age = Math.floor(
      (today.getTime() - new Date(a.last_updated).getTime()) / 86_400_000,
    )
    console.log(
      `  ${String(a.account_name).slice(0, 34).padEnd(34)} ${String(age).padStart(3)}d ` +
        `${age > staleDays ? 'STALE' : 'fresh'}`,
    )
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
