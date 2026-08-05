// TEMPORARY repair — undoes a conversion I performed by mistake during verification.
// A bad DOM ancestor-walk in my browser harness clicked the convert button on the
// $500 Sponsorship check (#1669) instead of the Rent payment I meant to test the
// guard against. This restores the payment exactly and removes the invoice it made.
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// The original row, from the pre-change inspection output.
const ORIGINAL = {
  id: '6ac7a282-7c1a-49df-a703-06277d88e47b',
  obligation_id: null,
  amount: 500,
  payment_date: '2026-08-05',
  payment_method: 'check',
  check_number: '1669',
  bank_account_id: 'cec6e032-d5f6-4518-9d9d-04a96672fd2d',
  status: 'outstanding',
  payee_name: 'South Lafourche High School',
  purpose: 'Sponsorship',
}

async function main() {
  // 1. Find the invoice the mistaken conversion created. Matched narrowly so this
  //    can never delete one of the owner's real obligations.
  const { data: bad, error: findErr } = await db
    .from('cash_obligations')
    .select('id, obligation_name, vendor_name, amount, notes')
    .eq('vendor_name', 'South Lafourche High School')
    .eq('amount', 500)
  if (findErr) throw new Error('lookup failed: ' + findErr.message)

  const converted = (bad ?? []).filter((b) =>
    (b.notes ?? '').includes('Converted from a recorded'),
  )
  console.log('[v0] mistaken invoices found:', converted.length)
  if (converted.length !== 1) {
    throw new Error(`expected exactly 1 mistaken invoice, found ${converted.length}. Aborting.`)
  }

  // 2. Restore the payment FIRST, so the money is never missing from both places.
  const { error: insErr } = await db.from('obligation_payments').insert(ORIGINAL)
  if (insErr) throw new Error('restore insert failed: ' + insErr.message)
  console.log('[v0] payment restored:', ORIGINAL.id)

  // 3. Only then remove the invoice, so we are never double-counting for long.
  const { error: delErr } = await db
    .from('cash_obligations')
    .delete()
    .eq('id', converted[0].id)
  if (delErr) throw new Error('invoice delete failed: ' + delErr.message)
  console.log('[v0] mistaken invoice removed:', converted[0].id)

  // 4. The original audit rows were destroyed by the cascade and cannot be
  //    recovered. Record what happened rather than leaving a silent gap.
  await db.from('obligation_payment_audit').insert({
    payment_id: ORIGINAL.id,
    action: 'created',
    detail: {
      restored: true,
      reason:
        'Restored after an accidental convert-to-invoice during verification. Original audit history was lost to the delete cascade.',
    },
    created_by: 'v0-verification-repair',
  })

  const { data: after } = await db
    .from('obligation_payments')
    .select('id, amount, status')
  const outstanding = (after ?? []).filter((p) => p.status === 'outstanding')
  console.log('[v0] outstanding count now:', outstanding.length)
  console.log(
    '[v0] outstanding sum now:',
    outstanding.reduce((s, p) => s + Number(p.amount), 0).toFixed(2),
  )
}

main().catch((e) => {
  console.error('[v0] RESTORE FAILED:', e)
  process.exit(1)
})
