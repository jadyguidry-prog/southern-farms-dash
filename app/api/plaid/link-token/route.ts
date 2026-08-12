import { CountryCode, Products } from 'plaid'
import {
  describePlaidError,
  isPlaidConfigured,
  plaidClient,
  plaidEnv,
  plaidRedirectUri,
} from '@/lib/plaid-client'
import { createClient } from '@/lib/supabase/server'

/**
 * Mint a short-lived Plaid Link token.
 *
 * Link tokens are the only Plaid credential that may reach the browser: they
 * expire in minutes and cannot read data on their own. The permanent access token
 * is exchanged server-side in `/api/plaid/exchange` and never leaves the server.
 *
 * Requires a signed-in session. Without that check any visitor could mint tokens
 * against the farm's Plaid account and burn its Item quota.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!isPlaidConfigured()) {
    return Response.json(
      {
        ok: false,
        error:
          'Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to the project environment.',
      },
      { status: 503 },
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return Response.json(
      { ok: false, error: 'You must be signed in to connect a bank account.' },
      { status: 401 },
    )
  }

  try {
    // An itemId means "repair this existing connection" (update mode) rather than
    // "add a new one". Plaid requires the access token for that, and returns a
    // token that reopens the same institution for re-authentication.
    const body = await request.json().catch(() => ({}) as Record<string, unknown>)
    const itemId = typeof body.itemId === 'string' ? body.itemId : null

    let accessToken: string | undefined
    if (itemId) {
      const { createServiceClient } = await import('@/lib/supabase/service')
      const { decryptToken } = await import('@/lib/plaid-crypto')
      const db = createServiceClient()
      const { data } = await db
        .from('plaid_items')
        .select('access_token_encrypted')
        .eq('item_id', itemId)
        .maybeSingle()
      if (data?.access_token_encrypted) {
        accessToken = decryptToken(data.access_token_encrypted)
      }
    }

    // OAuth institutions — American Express among them — send the owner to the
    // bank's own site and back to this exact registered URI.
    //
    // NOT required on desktop/mobile web, contrary to an earlier comment here.
    // Per Plaid's OAuth guide, web integrations open the bank in a POP-UP (or a
    // new tab on mobile web) whether or not a redirect_uri is supplied, so Amex
    // links fine without one. What omitting it actually costs is webview
    // browsers (links opened from Mail, Facebook, etc.), which can't do pop-ups.
    // Sent only when configured: an empty string is rejected outright, and an
    // unregistered value fails link creation, so absent is safer than guessed.
    const redirectUri = plaidRedirectUri()

    const response = await plaidClient().linkTokenCreate({
      user: { client_user_id: user.id },
      client_name: 'Southern Farms Operations Center',
      language: 'en',
      country_codes: [CountryCode.Us],
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      // Transactions only. Requesting fewer products keeps the consent screen
      // honest about what the app actually reads.
      ...(accessToken
        ? { access_token: accessToken }
        : { products: [Products.Transactions] }),
    })

    return Response.json({
      ok: true,
      linkToken: response.data.link_token,
      expiration: response.data.expiration,
      environment: plaidEnv(),
      mode: accessToken ? 'update' : 'create',
      // Lets the panel warn that OAuth banks will fail before the owner tries one.
      oauthReady: Boolean(redirectUri),
    })
  } catch (error) {
    const message = describePlaidError(error)
    console.log('[v0] plaid/link-token failed:', message)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
