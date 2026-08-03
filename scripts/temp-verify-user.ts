/**
 * Creates or deletes a throwaway confirmed auth user so pages behind the login can
 * actually be opened in a browser and LOOKED AT.
 *
 * This exists because `curl`-ing a protected route returns 200 for the *login page*,
 * which proves nothing about the page you meant to check. The only way to verify what
 * the owner will really see is to be logged in.
 *
 *   npx tsx scripts/temp-verify-user.ts create
 *   npx tsx scripts/temp-verify-user.ts delete
 *
 * The account is deliberately disposable and must always be deleted afterwards.
 */

import { createClient } from '@supabase/supabase-js'

const EMAIL = 'v0-temp-verify@southernfarms.invalid'
const PASSWORD = 'TempVerify!2026-southern-farms'

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  // Assert rather than continue: a silent skip here would make the verification
  // that follows look like it passed when nothing was actually checked.
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function findExisting() {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (error) throw new Error(`listUsers failed: ${error.message}`)
  return data.users.find((u) => u.email === EMAIL) ?? null
}

// Wrapped in a function because this repo's tsx transform targets CJS, where
// top-level await is a build error.
async function main() {
  const mode = process.argv[2]

  if (mode === 'create') {
    const existing = await findExisting()
    if (existing) {
      console.log(`[v0] temp user already exists: ${existing.id}`)
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email: EMAIL,
        password: PASSWORD,
        // Confirmed on creation, so no email round-trip is needed.
        email_confirm: true,
      })
      if (error) throw new Error(`createUser failed: ${error.message}`)
      console.log(`[v0] temp user created: ${data.user?.id}`)
    }
    console.log(`[v0] email:    ${EMAIL}`)
    console.log(`[v0] password: ${PASSWORD}`)
  } else if (mode === 'delete') {
    const existing = await findExisting()
    if (!existing) {
      console.log('[v0] no temp user to delete.')
    } else {
      const { error } = await admin.auth.admin.deleteUser(existing.id)
      if (error) throw new Error(`deleteUser failed: ${error.message}`)
      console.log(`[v0] temp user deleted: ${existing.id}`)
    }
  } else {
    throw new Error('Usage: temp-verify-user.ts <create|delete>')
  }
}

main().catch((err) => {
  console.error('[v0] temp-verify-user failed:', err)
  process.exit(1)
})
