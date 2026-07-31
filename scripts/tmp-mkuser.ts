import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
;(async () => {
  const email = 'v0-verify-temp@southernfarms.test'
  const { data: list } = await db.auth.admin.listUsers()
  const existing = list.users.find((u) => u.email === email)
  if (existing) await db.auth.admin.deleteUser(existing.id)
  const { data, error } = await db.auth.admin.createUser({
    email, password: 'Verify-Temp-9134!', email_confirm: true,
  })
  console.log(error ? 'ERR ' + error.message : 'created ' + data.user?.email)
})()
