import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
async function main() {
  const sb = createClient(url, anon)
  const { data, error } = await sb.auth.signInWithPassword({
    email: 'v0-verify-temp@southernfarms.test',
    password: 'Verify-Temp-9134!',
  })
  console.log('signIn error:', error ? `${error.status} ${error.message}` : 'none')
  console.log('session:', data.session ? 'yes' : 'no')
}
main()
