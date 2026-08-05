// TEMPORARY verification helper — deleted after use.
// Raw DB facts only. Deliberately does NOT re-implement any page's data assembly:
// the displayed figures are verified in the browser instead, because a script that
// recomputes page logic drifts from the page and reports a different business.
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const TARGET_IDS = [
  'f6c86ce9-e270-42f9-ba33-3febb9e6bd57', // Sysco 5025.70
  '37e75689-5603-4076-8c70-4e4d7cab1129', // Quirch 3795.33
  '6225bea4-9db2-4f2c-a22a-c1f8e2c2cdd1', // Gator Joe 382
  '926432a9-2c80-4e77-984f-481de511c589', // Law Office 375
  'f425febe-10be-4f7b-a53c-e4b521afea11', // Cockeyed 528
]

async function main() {
  const { data: pays, error: pErr } = await db
    .from('obligation_payments')
    .select('id, amount, status, payee_name, check_number')
  if (pErr) throw new Error('payments unreadable: ' + pErr.message)

  const outstanding = (pays ?? []).filter((p) => p.status === 'outstanding')
  const sum = outstanding.reduce((s, p) => s + Number(p.amount), 0)

  const { data: obs, error: oErr } = await db
    .from('cash_obligations')
    .select('id, obligation_name, vendor_name, amount, due_date, status, payment_method, notes')
  if (oErr) throw new Error('obligations unreadable: ' + oErr.message)

  console.log('[v0] outstanding count:', outstanding.length)
  console.log('[v0] outstanding sum:', sum.toFixed(2))
  console.log('[v0] total payment rows:', pays?.length)
  console.log('[v0] obligations count:', obs?.length)

  const stillThere = TARGET_IDS.filter((id) => (pays ?? []).some((p) => p.id === id))
  console.log('[v0] target payments still present:', stillThere.length, 'of 5')

  const converted = (obs ?? []).filter((o) => (o.notes ?? '').includes('Converted from a recorded'))
  console.log('[v0] converted invoices found:', converted.length)
  for (const c of converted) {
    console.log(
      '[v0]   ',
      JSON.stringify({
        name: c.obligation_name,
        vendor: c.vendor_name,
        amount: Number(c.amount),
        due: c.due_date,
        status: c.status,
        method: c.payment_method,
      }),
    )
  }
}

main().catch((e) => {
  console.error('[v0] snapshot failed:', e)
  process.exit(1)
})
