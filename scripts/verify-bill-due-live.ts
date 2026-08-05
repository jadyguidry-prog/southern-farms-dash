/**
 * Live round-trip for "enter a bill due" -> pay it -> it closes.
 *
 * The pure tests in verify-bill-due.ts prove the RULES; this proves the actual
 * columns, defaults and status transition work against the real database, then
 * deletes everything it created. Every value written is prefixed so a leftover
 * row is obvious.
 *
 * Run: set -a && source /vercel/share/.env.project && set +a && npx tsx scripts/verify-bill-due-live.ts
 */

import { createClient } from '@supabase/supabase-js'
import { resolveOneTimeBillStatus } from '../lib/bill-pay-shared'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('Missing Supabase env')

const db = createClient(url, key, { auth: { persistSession: false } })
const TAG = 'V0-VERIFY-BILL-DUE'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  const createdObligations: string[] = []
  const createdPayments: string[] = []

  try {
    // ---- 1. Insert a bill exactly as createBillDue does ----
    const { data: bill, error: billErr } = await db
      .from('cash_obligations')
      .insert({
        obligation_name: `${TAG} feed delivery`,
        vendor_name: `${TAG} vendor`,
        amount: 1000,
        due_date: '2026-08-20',
        next_due_date: '2026-08-20',
        recurring: false,
        frequency: 'One-time',
        status: 'Pending',
        active: true,
        payment_method: 'Check',
        invoice_number: `${TAG}-4471`,
        category: null,
        notes: null,
      })
      .select('id, status, amount, invoice_number, recurring')
      .single()

    if (billErr) throw new Error(`insert failed: ${billErr.message}`)
    createdObligations.push(bill.id)

    console.log('\n1. The bill inserts with the real columns')
    check('row created', Boolean(bill.id))
    check('starts Pending (shows as owed)', bill.status === 'Pending')
    check('invoice number persisted', bill.invoice_number === `${TAG}-4471`)
    check('is one-time, so it will close not roll', bill.recurring === false)

    // ---- 2. A PARTIAL payment must leave it open ----
    const { data: p1, error: p1Err } = await db
      .from('obligation_payments')
      .insert({
        obligation_id: bill.id,
        amount: 400,
        payment_date: '2026-08-05',
        payment_method: 'check',
        check_number: '9001',
        status: 'outstanding',
        memo: TAG,
      })
      .select('id')
      .single()
    if (p1Err) throw new Error(`payment 1 failed: ${p1Err.message}`)
    createdPayments.push(p1.id)

    const sumNonVoid = async () => {
      const { data } = await db
        .from('obligation_payments')
        .select('amount')
        .eq('obligation_id', bill.id)
        .neq('status', 'void')
      return (data ?? []).reduce((s, r) => s + (Number(r.amount) || 0), 0)
    }

    console.log('\n2. A partial payment leaves the bill open')
    const after1 = await sumNonVoid()
    check('400 of 1000 recorded', after1 === 400, String(after1))
    check(
      'status stays Pending — $600 is still genuinely owed',
      resolveOneTimeBillStatus(Number(bill.amount), after1) === 'Pending',
    )

    // ---- 3. The remaining payment closes it ----
    const { data: p2, error: p2Err } = await db
      .from('obligation_payments')
      .insert({
        obligation_id: bill.id,
        amount: 600,
        payment_date: '2026-08-06',
        payment_method: 'check',
        check_number: '9002',
        status: 'outstanding',
        memo: TAG,
      })
      .select('id')
      .single()
    if (p2Err) throw new Error(`payment 2 failed: ${p2Err.message}`)
    createdPayments.push(p2.id)

    const after2 = await sumNonVoid()
    const finalStatus = resolveOneTimeBillStatus(Number(bill.amount), after2)
    console.log('\n3. Full coverage closes the bill')
    check('1000 of 1000 recorded', after2 === 1000, String(after2))
    check('status resolves to Paid', finalStatus === 'Paid')

    // Apply it for real, and confirm the write sticks.
    const { error: upErr } = await db
      .from('cash_obligations')
      .update({ status: finalStatus })
      .eq('id', bill.id)
    check('status update accepted by the DB', !upErr, upErr?.message)

    const { data: reread } = await db
      .from('cash_obligations')
      .select('status')
      .eq('id', bill.id)
      .single()
    check('re-read confirms Paid', reread?.status === 'Paid', String(reread?.status))
    check(
      "so it drops off Bill Pay's payable list (status !== 'Paid')",
      reread?.status === 'Paid',
    )

    // ---- 4. Voiding a payment must REOPEN the bill ----
    // The mirror of the partial case: a voided check never left the account, so
    // the money is owed again and the bill must not stay closed.
    await db.from('obligation_payments').update({ status: 'void' }).eq('id', p2.id)
    const afterVoid = await sumNonVoid()
    console.log('\n4. Voiding a payment reopens the bill')
    check('void excluded from the total', afterVoid === 400, String(afterVoid))
    check(
      'status resolves back to Pending',
      resolveOneTimeBillStatus(Number(bill.amount), afterVoid) === 'Pending',
    )
  } finally {
    // ---- Cleanup: leave the database exactly as found ----
    if (createdPayments.length) {
      await db.from('obligation_payments').delete().in('id', createdPayments)
    }
    if (createdObligations.length) {
      await db.from('cash_obligations').delete().in('id', createdObligations)
    }
    const { data: leftoverOb } = await db
      .from('cash_obligations')
      .select('id')
      .ilike('obligation_name', `${TAG}%`)
    const { data: leftoverPay } = await db
      .from('obligation_payments')
      .select('id')
      .eq('memo', TAG)
    console.log('\n5. Cleanup')
    check('no test obligations left behind', (leftoverOb ?? []).length === 0)
    check('no test payments left behind', (leftoverPay ?? []).length === 0)
  }

  console.log(`\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('[v0] live verification error:', e)
  process.exit(1)
})
