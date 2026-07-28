import 'server-only'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * Service-role Supabase client for trusted background work (scheduled Square
 * syncs, CLI verification) that runs OUTSIDE a web request.
 *
 * Why this exists: `lib/supabase/server.ts` builds its client from `cookies()`,
 * which only exists inside a request. That is correct for user-facing code, but
 * it means anything cron-driven or run from a script throws
 * "`cookies` was called outside a request scope". The sync engine needs to work
 * in both places.
 *
 * This key BYPASSES row level security, so:
 *  - `server-only` keeps it out of any client bundle.
 *  - Use it only for the sync writer. Never use it to serve user-facing reads,
 *    because RLS is what scopes those to the signed-in user.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url) {
    throw new Error(
      'Supabase URL is not set (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL).',
    )
  }
  if (!serviceKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set, so background Square syncs cannot ' +
        'write. Add it to the project environment, or run the sync from the ' +
        'Settings screen instead.',
    )
  }

  // No session persistence or token refresh: this client is stateless and must
  // never pick up a user session.
  return createSupabaseClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
