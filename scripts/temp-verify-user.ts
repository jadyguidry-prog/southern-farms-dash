/**
 * Creates or deletes a temporary CONFIRMED Supabase user so authenticated pages
 * can actually be verified in a browser.
 *
 * `curl` returning 200 behind auth proves nothing — it is the login page. The
 * only way to confirm what the owner will see is to sign in and look.
 *
 *   npx tsx --env-file=.env.development.local scripts/temp-verify-user.ts create
 *   npx tsx --env-file=.env.development.local scripts/temp-verify-user.ts delete
 *
 * The credentials are defined HERE and must be read from this file rather than
 * retyped from memory — a mistyped email produces an "Invalid login credentials"
 * error that looks like a broken auth flow and wastes a debugging cycle.
 */
import { createClient } from '@supabase/supabase-js'

export const TEMP_EMAIL = 'v0-verify@southernfarms.local'
export const TEMP_PASSWORD = 'v0-verify-temp-password-2026'

async function main() {
  const mode = process.argv[2]
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  const db = createClient(url, key, { auth: { persistSession: false } })

  // Find any existing temp user first, so repeated runs are idempotent rather
  // than failing on a duplicate address.
  const { data: list, error: listErr } = await db.auth.admin.listUsers({ perPage: 1000 })
  if (listErr) throw listErr
  const existing = list.users.find((u) => u.email === TEMP_EMAIL)

  if (mode === 'create') {
    if (existing) {
      await db.auth.admin.updateUserById(existing.id, {
        password: TEMP_PASSWORD,
        email_confirm: true,
      })
      console.log(`[v0] reused temp user ${TEMP_EMAIL}`)
      return
    }
    const { error } = await db.auth.admin.createUser({
      email: TEMP_EMAIL,
      password: TEMP_PASSWORD,
      email_confirm: true,
    })
    if (error) throw error
    console.log(`[v0] created temp user ${TEMP_EMAIL}`)
    return
  }

  if (mode === 'delete') {
    if (!existing) {
      console.log('[v0] no temp user to delete')
      return
    }
    const { error } = await db.auth.admin.deleteUser(existing.id)
    if (error) throw error
    console.log(`[v0] deleted temp user ${TEMP_EMAIL}`)
    return
  }

  throw new Error('usage: temp-verify-user.ts create|delete')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
