import { runFullSync, runServiceRoleSync } from '@/lib/square-sync'

/**
 * Nightly Square sync.
 *
 * This exists because the sync was previously manual-only: it ran when someone
 * remembered to press the button in Settings. It had fallen four days behind,
 * which quietly understated July sales by roughly $17,500 on the dashboard --
 * no error, just a smaller number than reality.
 *
 * Scheduled from `vercel.json`. Vercel Cron sends the request with
 * `Authorization: Bearer $CRON_SECRET`, so the handler authenticates before
 * doing any work.
 */

// The sync pages through orders, payments, refunds and shifts, then rebuilds the
// rollups, so give it well beyond a default serverless timeout.
export const maxDuration = 300
// Never cached or prerendered: it mutates data and must run on request.
export const dynamic = 'force-dynamic'

function unauthorized(reason: string) {
  console.log('[v0] cron/square-sync rejected:', reason)
  return Response.json({ ok: false, error: reason }, { status: 401 })
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')

  if (secret) {
    if (auth !== `Bearer ${secret}`) {
      return unauthorized('invalid or missing bearer token')
    }
  } else if (process.env.NODE_ENV === 'production') {
    /*
     * Refuse rather than run. Without a secret this endpoint would let anyone on
     * the internet trigger a full Square sync against the live database, so a
     * missing secret has to fail closed. Local development is allowed through so
     * the sync stays runnable while iterating.
     */
    console.log('[v0] cron/square-sync: CRON_SECRET is not set in production')
    return Response.json(
      {
        ok: false,
        error:
          'CRON_SECRET is not configured. Add it in project settings so the scheduled sync can authenticate.',
      },
      { status: 503 },
    )
  }

  const startedAt = new Date().toISOString()

  try {
    // Incremental by default: `runFullSync` resumes from the stored cursor and
    // upserts by order id and date, so an overlapping or repeated run cannot
    // double-count sales.
    // Service role: a cron request carries no Supabase session, so RLS would
    // reject every write. Authentication happened above via CRON_SECRET.
    const result = await runServiceRoleSync(() => runFullSync())

    console.log(
      '[v0] cron/square-sync finished:',
      JSON.stringify({
        ok: result.ok,
        ordersSynced: result.ordersSynced,
        error: result.error ?? null,
      }),
    )

    return Response.json(
      {
        ok: result.ok,
        startedAt,
        finishedAt: result.finishedAt,
        ordersSynced: result.ordersSynced,
        outcomes: result.outcomes,
        error: result.error ?? null,
      },
      // A failed sync returns 500 so the Vercel cron log shows it as failed
      // rather than a silent success, which is how this drifted unnoticed before.
      { status: result.ok ? 200 : 500 },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log('[v0] cron/square-sync threw:', message)
    return Response.json({ ok: false, startedAt, error: message }, { status: 500 })
  }
}
