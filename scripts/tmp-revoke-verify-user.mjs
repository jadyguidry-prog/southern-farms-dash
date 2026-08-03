// Throwaway: deletes the temporary browser-verification account.
// Removed immediately after running.
import { createClient } from '@supabase/supabase-js'

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const TEMP_ID = '04d4ad6a-52d5-497f-9d44-833306d97eda'

// Guard: only ever delete the known temp .test account, never a real login.
const { data: found, error: getErr } = await admin.auth.admin.getUserById(TEMP_ID)
if (getErr) {
  console.log('LOOKUP ERROR:', getErr.message)
  process.exit(1)
}
if (!found.user.email.endsWith('@southernfarms.test')) {
  console.log('REFUSING: not a temp .test account ->', found.user.email)
  process.exit(1)
}

const { error } = await admin.auth.admin.deleteUser(TEMP_ID)
console.log(error ? 'DELETE ERROR: ' + error.message : 'DELETED ' + found.user.email)
