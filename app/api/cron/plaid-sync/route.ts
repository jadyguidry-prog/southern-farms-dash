import { syncAllItems } from '@/lib/plaid-sync'

/**
 * Nightly Plaid sync for the bank and card accounts.
 *
 * Same shape and auth model as `cron/square-sync`: Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`, and a missing secret fails closed in
 * production rather than leaving an open endpoint that writes to the ledger.
 *
 * Scheduled from `vercel.json`.
 */

// Plaid pages through transactions per institution, so allow well past the
// default serverless timeout.
export const maxDuration = 300
export const dynamic = 'force-dynamic'

function unauthorized(reason: string) {
  console.log('[v0] cron/plaid-sync rejected:', reason)
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
    console.log('[v0] cron/plaid-sync: CRON_SECRET is not set in production')
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
    const { results, configured } = await syncAllItems()

    if (!configured) {
      // Not an error: Plaid simply is not set up yet. Return 200 so the cron log
      // does not fill with false failures before the keys are added.
      return Response.json(
        {
          ok: true,
          startedAt,
          skipped: 'Plaid is not configured (PLAID_CLIENT_ID / PLAID_SECRET).',
          results: [],
        },
        { status: 200 },
      )
    }

    const failed = results.filter((r) => r.status === 'error')
    const reauth = results.filter((r) => r.needsReauth)

    console.log(
      '[v0] cron/plaid-sync finished:',
      JSON.stringify({
        items: results.length,
        added: results.reduce((s, r) => s + r.added, 0),
        failed: failed.length,
        reauth: reauth.length,
      }),
    )

    return Response.json(
      {
        ok: failed.length === 0,
        startedAt,
        finishedAt: new Date().toISOString(),
        results,
        // Called out separately because this is the one failure mode the owner has
        // to resolve by hand, by reconnecting the bank in Settings.
        needsReauth: reauth.map((r) => r.institution ?? r.itemId),
      },
      // Non-200 on failure so a broken sync shows as failed in the Vercel cron log
      // instead of drifting silently, which is how the Square sync fell 4 days behind.
      { status: failed.length === 0 ? 200 : 500 },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log('[v0] cron/plaid-sync threw:', message)
    return Response.json({ ok: false, startedAt, error: message }, { status: 500 })
  }
}
