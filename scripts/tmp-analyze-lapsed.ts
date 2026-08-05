/**
 * Throwaway analysis: is amount-matching a real signal for identifying which
 * payee-less checks are the lapsed marketing channels?
 *
 * Calls the app's OWN pure `reconcileKnownSpend` rather than re-deriving
 * "lapsed" or "payee-less" locally. My first attempt re-implemented both and
 * reported 1 channel / 0 unnamed checks against the page's 6 / 165 — the exact
 * drift this rule exists to prevent.
 */
import { createClient } from '@supabase/supabase-js'
import { reconcileKnownSpend } from '@/lib/marketing-affordability-service'
import { isGenericDescription } from '@/lib/transaction-groups'
import { SPEND_TYPES } from '@/lib/transactions'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type Raw = {
  id: string
  transaction_date: string | null
  description: string | null
  normalized_description: string | null
  amount: number | string
  transaction_type: string | null
  review_status: string | null
  vendor_id: string | null
  expense_category: string | null
  account_name: string | null
  check_number: string | null
}

async function fetchAll<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = []
  const size = 1000
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase
      .from(table)
      .select(cols)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, from + size - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data?.length) break
    out.push(...(data as T[]))
    if (data.length < size) break
  }
  return out
}

async function main() {
  const raw = await fetchAll<Raw>(
    'financial_transactions',
    'id, transaction_date, description, normalized_description, amount, transaction_type, review_status, vendor_id, expense_category, account_name, check_number',
  )
  console.log('transactions loaded:', raw.length)

  // Same row shape the service builds.
  const rows = raw.map((r) => ({
    id: r.id,
    transactionDate: (r.transaction_date ?? '').slice(0, 10),
    description: r.description ?? r.normalized_description ?? '',
    amount: Number(r.amount) || 0,
    transactionType: r.transaction_type ?? '',
    reviewStatus: r.review_status ?? '',
    vendorId: r.vendor_id ?? null,
    expenseCategory: r.expense_category ?? '',
    accountName: r.account_name ?? '',
  }))

  const { data: vendors } = await supabase
    .from('vendors')
    .select('id, category')
    .eq('category', 'Marketing')
  const marketingVendorIds = new Set((vendors ?? []).map((v) => String(v.id)))

  // Overlay rows the owner already resolved — omitting these would count their
  // completed work as still-unknown (the mistake verify-check-resolution made).
  const { data: resRows } = await supabase
    .from('check_resolutions')
    .select('financial_transaction_id, resolved_payee, resolved_category, review_status')
  const resolutions = new Map<string, { payee: string; category: string }>()
  for (const r of resRows ?? []) {
    if ((r as { review_status?: string }).review_status !== 'approved') continue
    const id = String((r as { financial_transaction_id?: string }).financial_transaction_id ?? '')
    if (!id) continue
    resolutions.set(id, {
      payee: String((r as { resolved_payee?: string }).resolved_payee ?? ''),
      category: String((r as { resolved_category?: string }).resolved_category ?? ''),
    })
  }
  console.log('approved resolutions:', resolutions.size)

  const today = new Date()
  const rec = reconcileKnownSpend(rows, marketingVendorIds, today, 2, {}, resolutions)

  console.log('\n=== lapsed channels (app\'s own verdict) ===')
  // How many DISTINCT months did each so-called channel ever charge in? A
  // channel seen in exactly one month was never recurring, so it cannot have
  // "stopped" — it was a one-off purchase.
  const monthsPerChannel = new Map<string, Set<string>>()
  const chargesPerChannel = new Map<string, number>()
  for (const r of rows) {
    if (r.reviewStatus === 'excluded') continue
    if (!SPEND_TYPES.includes(r.transactionType as never)) continue
    if (isGenericDescription(r.description)) continue
    for (const l of rec.lapsed) {
      if (!r.description.toUpperCase().includes(l.channel.toUpperCase())) continue
      if (!monthsPerChannel.has(l.channel)) monthsPerChannel.set(l.channel, new Set())
      monthsPerChannel.get(l.channel)!.add(r.transactionDate.slice(0, 7))
      chargesPerChannel.set(l.channel, (chargesPerChannel.get(l.channel) ?? 0) + 1)
    }
  }
  for (const l of rec.lapsed) {
    console.log(
      `  LAPSED   ${l.channel.slice(0, 40).padEnd(42)} last=${l.lastDate} quiet=${String(l.monthsSinceLastCharge).padStart(2)}mo typical=$${l.typicalMonthly.toFixed(0).padStart(4)} months=${l.activeMonths} charges=${l.chargeCount} fromChecks=${l.identifiedFromChecks}`,
    )
  }
  for (const o of rec.oneOffPurchases) {
    console.log(
      `  ONE-OFF  ${o.channel.slice(0, 40).padEnd(42)} on=${o.lastDate}   amount=$${o.typicalMonthly.toFixed(0).padStart(4)} months=${o.activeMonths} charges=${o.chargeCount}`,
    )
  }
  void monthsPerChannel
  void chargesPerChannel
  console.log('\nunattributable:', rec.unattributable.count, 'rows, $' + rec.unattributable.total.toFixed(2))
  console.log('already resolved:', rec.resolved.count, 'rows, $' + rec.resolved.total.toFixed(2))

  // --- the unnamed pool, with amounts ------------------------------------
  const unnamed = rows.filter(
    (r) =>
      r.reviewStatus !== 'excluded' &&
      SPEND_TYPES.includes(r.transactionType as never) &&
      isGenericDescription(r.description) &&
      !resolutions.has(r.id),
  )
  console.log('\nunnamed pool re-derived for amount analysis:', unnamed.length, 'rows')

  // Per-channel historical amounts, so we can look for exact repeats.
  const histAmounts = new Map<string, Map<number, number>>()
  for (const r of rows) {
    if (r.reviewStatus === 'excluded') continue
    if (!SPEND_TYPES.includes(r.transactionType as never)) continue
    if (isGenericDescription(r.description)) continue
    const chan = rec.lapsed.find((l) =>
      r.description.toUpperCase().includes(l.channel.toUpperCase()),
    )
    if (!chan) continue
    const k = Math.round(Math.abs(r.amount) * 100) / 100
    if (!histAmounts.has(chan.channel)) histAmounts.set(chan.channel, new Map())
    const m = histAmounts.get(chan.channel)!
    m.set(k, (m.get(k) ?? 0) + 1)
  }

  console.log('\n=== do lapsed-channel amounts recur among unnamed checks after they went quiet? ===')
  let hits = 0
  for (const l of rec.lapsed) {
    const amounts = histAmounts.get(l.channel)
    if (!amounts || amounts.size === 0) {
      console.log(`  ${l.channel}: no historical amounts recovered (channel name not in descriptions)`)
      continue
    }
    const after = unnamed.filter((u) => u.transactionDate > l.lastDate)
    const matches = after.filter((u) =>
      [...amounts.keys()].some((a) => Math.abs(Math.abs(u.amount) - a) < 0.01),
    )
    if (matches.length) {
      hits += matches.length
      console.log(`  ${l.channel}: ${matches.length} exact-amount match(es) among ${after.length} later unnamed checks`)
      for (const m of matches.slice(0, 5)) {
        console.log(`      ${m.transactionDate}  $${Math.abs(m.amount).toFixed(2)}`)
      }
    } else {
      console.log(`  ${l.channel}: 0 matches among ${after.length} later unnamed checks`)
    }
  }
  if (hits === 0) {
    console.log('\n  >>> amount-matching finds NOTHING. Do not ship UI implying it works.')
  }

  // --- what SIZE are the unnamed checks? ---------------------------------
  const sorted = [...unnamed].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  const total = unnamed.reduce((s, r) => s + Math.abs(r.amount), 0)
  console.log('\n=== unnamed pool shape ===')
  console.log('total: $' + total.toFixed(2))
  console.log('top 12 by size (these dominate the dollars):')
  let running = 0
  for (const r of sorted.slice(0, 12)) {
    running += Math.abs(r.amount)
    console.log(
      `    ${r.transactionDate}  $${Math.abs(r.amount).toFixed(2).padStart(10)}  ${(running / total * 100).toFixed(1)}% cumulative`,
    )
  }
  // How few rows cover most of the money? That decides whether this is a
  // tractable afternoon of work or an endless queue.
  let acc = 0
  let n80 = 0
  for (const r of sorted) {
    acc += Math.abs(r.amount)
    n80 += 1
    if (acc >= total * 0.8) break
  }
  console.log(`\n  ${n80} of ${unnamed.length} rows cover 80% of the unnamed dollars.`)

  // Marketing-sized rows: could a lapsed channel plausibly hide here at all?
  const maxTypical = Math.max(0, ...rec.lapsed.map((l) => l.typicalMonthly))
  const plausible = unnamed.filter((r) => Math.abs(r.amount) <= maxTypical * 1.5)
  console.log(
    `  rows small enough to be one of these channels (<= 1.5x $${maxTypical.toFixed(0)}): ${plausible.length}, $${plausible.reduce((s, r) => s + Math.abs(r.amount), 0).toFixed(2)}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
