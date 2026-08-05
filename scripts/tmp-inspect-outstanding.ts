/**
 * TEMPORARY read-only inspection of outstanding checks. Deleted after use.
 * No writes — this only reports what is currently stored.
 */
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  const { data: pays, error } = await db
    .from('obligation_payments')
    .select('*')
    .neq('status', 'void')
    .order('payment_date')
  if (error) throw error

  console.log('[v0] non-void payments total:', pays!.length)
  const outstanding = pays!.filter((p) => p.status === 'outstanding')
  console.log('[v0] OUTSTANDING count:', outstanding.length)
  console.log('[v0] columns:', Object.keys(pays![0] ?? {}).join(', '))

  console.log('\n[v0] === OUTSTANDING CHECKS ===')
  for (const p of outstanding) {
    console.log(
      JSON.stringify({
        id: p.id,
        payee: p.payee_name ?? p.vendor_name ?? null,
        amount: p.amount,
        date: p.payment_date,
        purpose: p.purpose,
        check_no: p.check_number,
        method: p.payment_method,
        obligation_id: p.obligation_id,
        bank_account_id: p.bank_account_id,
        cleared_date: p.cleared_date,
      }),
    )
  }

  // Which of these point at a real obligation, and what is that obligation?
  const oblIds = [...new Set(outstanding.map((p) => p.obligation_id).filter(Boolean))]
  console.log('\n[v0] distinct obligation_ids referenced:', oblIds.length)
  if (oblIds.length) {
    const { data: obls, error: oe } = await db
      .from('cash_obligations')
      .select('id, obligation_name, vendor_name, amount, recurring, frequency, status, due_date')
      .in('id', oblIds as string[])
    if (oe) throw oe
    for (const o of obls!) {
      console.log('[v0] OBL', JSON.stringify(o))
    }
  }

  console.log('\n[v0] === ALL cash_obligations (for context) ===')
  const { data: allObl, error: ae } = await db
    .from('cash_obligations')
    .select('id, obligation_name, vendor_name, amount, recurring, frequency, status, due_date')
    .order('obligation_name')
  if (ae) throw ae
  for (const o of allObl!) console.log('[v0]', JSON.stringify(o))

  console.log('\n[v0] cash_obligations columns:')
  console.log('[v0]', Object.keys(allObl![0] ?? {}).join(', '))
}

main().catch((e) => {
  console.error('[v0] inspect failed:', e)
  process.exit(1)
})
