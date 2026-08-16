import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function main() {
  // 1. How are CHECK rows stored anywhere in the table?
  const { data: chk } = await db
    .from('financial_transactions')
    .select(
      'transaction_date, description, amount, transaction_type, expense_category, check_number, account_name, review_status, source_file_name',
    )
    .ilike('description', 'CHECK%')
    .is('deleted_at', null)
    .order('transaction_date', { ascending: false })
    .limit(14)
  console.log(`=== CHECK-like rows (latest 14):`)
  for (const r of (chk ?? []) as any[]) {
    console.log(
      `  ${r.transaction_date} amt=${String(r.amount).padStart(9)} type=${String(r.transaction_type).padEnd(8)} chk=${JSON.stringify(r.check_number)} cat=${r.expense_category} rev=${r.review_status} desc=${JSON.stringify(String(r.description).slice(0, 26))}`,
    )
  }
  const { count: chkCount } = await db
    .from('financial_transactions')
    .select('id', { count: 'exact', head: true })
    .not('check_number', 'is', null)
    .is('deleted_at', null)
  console.log(`  rows with check_number set: ${chkCount}`)

  // 2. Square Inc SQ rows that are NOT income -> how is a customer refund typed?
  const { data: sq } = await db
    .from('financial_transactions')
    .select('transaction_date, description, amount, transaction_type, expense_category, account_name')
    .ilike('description', 'Square Inc SQ%')
    .neq('transaction_type', 'income')
    .is('deleted_at', null)
    .order('transaction_date', { ascending: false })
    .limit(20)
  console.log(`\n=== "Square Inc SQ..." rows NOT typed income: ${(sq ?? []).length}`)
  for (const r of (sq ?? []) as any[]) {
    console.log(
      `  ${r.transaction_date} amt=${String(r.amount).padStart(9)} type=${String(r.transaction_type).padEnd(8)} cat=${r.expense_category} acct=${String(r.account_name).slice(0, 18)}`,
    )
  }

  // 3. Every distinct transaction_type in the table, with counts.
  const all: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data } = await db
      .from('financial_transactions')
      .select('transaction_type, expense_category, description')
      .is('deleted_at', null)
      .order('id')
      .range(from, from + 999)
    const page = data ?? []
    all.push(...page)
    if (page.length < 1000) break
  }
  const t = new Map<string, number>()
  for (const r of all) t.set(String(r.transaction_type), (t.get(String(r.transaction_type)) ?? 0) + 1)
  console.log(`\n=== transaction_type across all ${all.length} rows:`)
  for (const [k, v] of [...t].sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(10)} ${v}`)

  // 4. What are the `fee` rows, so I type merchant fees consistently?
  const fees = all.filter((r) => r.transaction_type === 'fee')
  console.log(`\n=== sample 'fee' descriptions:`)
  for (const r of fees.slice(0, 10)) console.log(`  ${String(r.description).slice(0, 52)} cat=${r.expense_category}`)

  // 5. Valid expense_category values I should reuse (top 30).
  const c = new Map<string, number>()
  for (const r of all) if (r.expense_category) c.set(r.expense_category, (c.get(r.expense_category) ?? 0) + 1)
  console.log(`\n=== top expense_category values:`)
  for (const [k, v] of [...c].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${k.padEnd(28)} ${v}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
