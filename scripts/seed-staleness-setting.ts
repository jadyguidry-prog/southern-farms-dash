/**
 * Seeds the `account_data_stale_days` business setting.
 *
 * Kept as a script (rather than inline SQL) because the setting must exist as a real,
 * owner-editable row — the mirror in `SETTING_DEFAULTS` is only a fallback for a
 * fresh database, not a source of truth. Safe to re-run: it never overwrites an
 * existing value, so an owner adjustment survives.
 *
 * Run with:
 *   set -a && source /vercel/share/.env.project && set +a && npx tsx scripts/seed-staleness-setting.ts
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const SETTING = {
  setting_key: 'account_data_stale_days',
  label: 'Account Data Stale After (days)',
  value: 14,
  unit: 'days',
  notes:
    'Bank, card and credit-line balances are entered by hand. Once a figure is older ' +
    'than this, the Growth Planner still answers but shows how old it is and lowers ' +
    'its confidence. Raise it if you update balances less often; lower it for ' +
    'stricter checking.',
}

async function main() {
  const { data: existing, error: readErr } = await admin
    .from('business_settings')
    .select('setting_key, value')
    .eq('setting_key', SETTING.setting_key)
    .maybeSingle()

  // Assert rather than defaulting: a failed read must not be mistaken for "absent",
  // which would overwrite a value the owner had already tuned.
  if (readErr) throw new Error(`Could not read settings: ${readErr.message}`)

  if (existing) {
    console.log(
      `[v0] ${SETTING.setting_key} already set to ${existing.value} — left unchanged.`,
    )
    return
  }

  const { error } = await admin.from('business_settings').insert(SETTING)
  if (error) throw new Error(`Insert failed: ${error.message}`)
  console.log(`[v0] seeded ${SETTING.setting_key} = ${SETTING.value} days`)
}

main().catch((err) => {
  console.error('[v0] seed-staleness-setting failed:', err)
  process.exit(1)
})
