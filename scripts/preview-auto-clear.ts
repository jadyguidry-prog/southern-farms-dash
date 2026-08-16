// Read-only preview of what the auto-clear matcher would do to the REAL ledger.
//
// Writes nothing. Its whole job is to answer "would this be right?" before the feature
// is allowed anywhere near the database — the same dry-run-first discipline the August
// import used.
//
// Deliberately calls the SAME pure classifier the app calls, rather than
// re-implementing the matching rules here. A verification script that reproduces the
// logic it is checking will drift from it and start certifying its own bugs.

import { createClient } from '@supabase/supabase-js'
import {
  classifyClearCandidates,
  checkNumberOf,
  type AutoClearObligation,
  type AutoClearPayment,
  type AutoClearTxn,
} from '../lib/obligation-auto-clear'
import { SETTING_DEFAULTS } from '../lib/queries'

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function main() {
  const today = new Date().toISOString().slice(0, 10)

  // Read the owner's real settings. Asserted, never `?? 0`-defaulted: a failed read
  // that silently became 0 would empty the queue and look like "nothing to do".
  const { data: settingRows, error: sErr } = await db
    .from('business_settings')
    .select('setting_key, value')
    .in('setting_key', ['orphan_check_review_days', 'check_clear_window_days'])
  if (sErr) throw new Error(`settings unreadable: ${sErr.message}`)

  const setting = new Map((settingRows ?? []).map((r: any) => [r.setting_key, Number(r.value)]))
  const orphanReviewDays = setting.get('orphan_check_review_days') ?? SETTING_DEFAULTS.orphan_check_review_days
  const clearWindowDays = setting.get('check_clear_window_days') ?? SETTING_DEFAULTS.check_clear_window_days
  console.log(`today=${today}  clearWindow=${clearWindowDays}d  orphanReview=${orphanReviewDays}d`)
  if (!setting.has('orphan_check_review_days')) {
    console.log('(no owner override stored yet — using the shared default)')
  }

  const since = new Date(Date.now() - clearWindowDays * 86_400_000).toISOString().slice(0, 10)

  const { data: obRows, error: oErr } = await db
    .from('cash_obligations')
    .select('id, obligation_name, vendor_name, amount, status, active, payment_method')
  if (oErr) throw new Error(oErr.message)

  const { data: payRows, error: pErr } = await db
    .from('obligation_payments')
    .select('id, obligation_id, status, check_number, amount, payment_date, payee_name, cleared_transaction_id')
  if (pErr) throw new Error(pErr.message)

  const { data: txnRows, error: tErr } = await db
    .from('financial_transactions')
    .select('id, transaction_date, amount, description, check_number, transaction_type, bill_match_dismissed_at')
    .is('deleted_at', null)
    .in('transaction_type', ['expense', 'payment'])
    .gte('transaction_date', since)
  if (tErr) throw new Error(tErr.message)

  const obligations: AutoClearObligation[] = (obRows ?? []).map((o: any) => ({
    id: String(o.id),
    obligationName: String(o.obligation_name ?? ''),
    vendorName: String(o.vendor_name ?? ''),
    amount: Number(o.amount) || 0,
    status: String(o.status ?? 'Pending'),
    active: o.active !== false,
    paymentMethod: String(o.payment_method ?? ''),
  }))

  const payments: AutoClearPayment[] = (payRows ?? []).map((p: any) => ({
    id: String(p.id),
    obligationId: p.obligation_id ? String(p.obligation_id) : null,
    status: String(p.status ?? 'outstanding'),
    checkNumber: p.check_number ? String(p.check_number) : null,
    amount: Number(p.amount) || 0,
    paymentDate: String(p.payment_date ?? '').slice(0, 10),
    payee: String(p.payee_name ?? ''),
  }))

  const linked = (payRows ?? [])
    .filter((p: any) => p.cleared_transaction_id && p.status !== 'void')
    .map((p: any) => String(p.cleared_transaction_id))

  const txns = (txnRows ?? []) as AutoClearTxn[]

  const bankChecks = txns.filter((t) => checkNumberOf(t) !== null)
  console.log(
    `\nledger: ${obligations.length} obligations, ${payments.length} payments, ` +
      `${txns.length} outgoing rows since ${since} (${bankChecks.length} carry a check number), ` +
      `${linked.length} bank rows already linked`,
  )

  const result = classifyClearCandidates(obligations, payments, txns, linked, today, {
    orphanReviewDays,
    clearWindowDays,
  })

  const names = new Map(obligations.map((o) => [o.id, o.obligationName]))

  console.log(`\n=== WOULD AUTO-CLEAR (${result.autoClear.length}) ===`)
  if (result.autoClear.length === 0) console.log('  (none)')
  for (const m of result.autoClear) {
    console.log(`  check #${String(m.checkNumber).padEnd(6)} ${m.postedDate}  ${money(m.amount).padStart(11)}  ${m.label}`)
  }

  const byReason = new Map<string, typeof result.review>()
  for (const r of result.review) {
    const list = byReason.get(r.reason) ?? []
    list.push(r)
    byReason.set(r.reason, list)
  }

  console.log(`\n=== NEEDS REVIEW (${result.review.length}) ===`)
  for (const [reason, items] of byReason) {
    console.log(`\n  -- ${reason} (${items.length}) --`)
    for (const r of items.slice(0, 12)) {
      // Print the COUNT alongside the names. Both real Owner Draw bills are named
      // "Owner Draw", so two candidates rendered as one label and made a wrong
      // "more than one bill" message look merely odd rather than wrong.
      const n = r.candidateObligationIds.length
      const cands = r.candidateObligationIds.map((id) => names.get(id) ?? id).join(' | ')
      console.log(`     check #${String(r.checkNumber).padEnd(6)} ${r.postedDate} ${money(r.bankAmount).padStart(11)}`)
      console.log(`        ${r.explanation}`)
      if (cands) console.log(`        candidates (${n}): ${cands}`)
    }
    if (items.length > 12) console.log(`     ... and ${items.length - 12} more`)
  }

  // --- Safety assertions on the REAL data -------------------------------------------
  // A preview that only prints is easy to skim past. These fail loudly instead.
  console.log('\n=== SAFETY CHECKS ===')
  let bad = 0
  const assert = (label: string, cond: boolean, detail?: string) => {
    if (cond) console.log(`  ok   ${label}`)
    else {
      bad++
      console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    }
  }

  // Every auto-clear must point at a payment that is genuinely still outstanding.
  const payById = new Map(payments.map((p) => [p.id, p]))
  assert(
    'every auto-clear targets an outstanding payment',
    result.autoClear.every((m) => payById.get(m.paymentId)?.status === 'outstanding'),
  )

  // Amount must be exact, in cents, on every single one.
  assert(
    'every auto-clear amount matches the bank to the cent',
    result.autoClear.every((m) => {
      const p = payById.get(m.paymentId)
      return p ? Math.round(p.amount * 100) === Math.round(m.amount * 100) : false
    }),
  )

  // No bank row may be used twice, and none may already be linked.
  const usedTxn = result.autoClear.map((m) => m.transactionId)
  assert('no bank row is used twice', new Set(usedTxn).size === usedTxn.length)
  assert('no already-linked bank row is reused', usedTxn.every((id) => !linked.includes(id)))

  // No payment may be cleared twice in one pass.
  const usedPay = result.autoClear.map((m) => m.paymentId)
  assert('no payment is cleared twice', new Set(usedPay).size === usedPay.length)

  // The two real $1,500 Owner Draw bills must never be auto-resolved by amount.
  const draws = obligations.filter(
    (o) => o.active && o.status !== 'Paid' && Math.round(o.amount * 100) === 150000,
  )
  // Was written against a reason name that does not exist ('no_payment_recorded'), so it
  // could never fail and certified nothing. The real concern: while more than one $1,500
  // bill is open, no $1,500 check may be presented as a confident single match.
  if (draws.length > 1) {
    assert(
      `the ${draws.length} identical $1,500 bills are never offered as a confident match`,
      !result.review.some(
        (r) =>
          r.reason === 'possible_unrecorded_payment' &&
          Math.round(r.bankAmount * 100) === 150000,
      ),
      'an ambiguous $1,500 check was offered as a confident single match',
    )
  } else {
    console.log(
      `  --   only ${draws.length} open $1,500 bill right now, so the two-draw ambiguity case is not exercised`,
    )
  }

  // No message may claim several bills while naming only one. This is the exact bug this
  // preview caught on the real $550 Billboard checks, so it is asserted from now on
  // rather than left to be spotted by eye.
  assert(
    'no message claims "more than one bill" with a single candidate',
    !result.review.some(
      (r) => /more than one bill/i.test(r.explanation) && r.candidateObligationIds.length < 2,
    ),
    result.review.find(
      (r) => /more than one bill/i.test(r.explanation) && r.candidateObligationIds.length < 2,
    )?.explanation,
  )

  // A dismissed row must never appear in the queue again.
  const dismissedIds = new Set(txns.filter((t) => t.bill_match_dismissed_at).map((t) => t.id))
  assert(
    'dismissed rows stay out of the review queue',
    !result.review.some((r) => dismissedIds.has(r.transactionId)),
  )

  console.log(bad === 0 ? '\nAll safety checks passed. Nothing was written.' : `\n${bad} SAFETY CHECK(S) FAILED.`)
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
