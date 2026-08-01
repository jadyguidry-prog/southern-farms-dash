import {
  describePlaidError,
  isPlaidConfigured,
  isPlaidEncryptionConfigured,
  plaidClient,
} from '@/lib/plaid-client'
import { encryptToken } from '@/lib/plaid-crypto'
import { suggestAccountName } from '@/lib/plaid-transform'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Exchange a Plaid public token for the permanent access token.
 *
 * This is the security-critical step. The public token arrives from the browser
 * after the owner completes Link; it is traded server-side for an access token
 * that can read the account's full history. That token is encrypted immediately
 * and written to `plaid_items`, a table with zero client-facing RLS policies and
 * no anon/authenticated grants, so it is unreachable from the browser.
 *
 * Newly discovered accounts are stored UNMAPPED (account_name null). Nothing is
 * imported until the owner sets the account name and cutover date in Settings,
 * which is what prevents a first sync from re-importing CSV history.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!isPlaidConfigured()) {
    return Response.json(
      { ok: false, error: 'Plaid is not configured.' },
      { status: 503 },
    )
  }

  // Refuse to store a bank credential in plaintext. Failing here is far better
  // than a database holding usable tokens.
  if (!isPlaidEncryptionConfigured()) {
    return Response.json(
      {
        ok: false,
        error:
          'PLAID_ENCRYPTION_KEY is not set, so the access token cannot be stored safely. Generate one with: openssl rand -base64 32',
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
    const body = await request.json()
    const publicToken = body?.publicToken

    if (typeof publicToken !== 'string' || !publicToken) {
      return Response.json(
        { ok: false, error: 'A public token is required.' },
        { status: 400 },
      )
    }

    const client = plaidClient()
    const exchange = await client.itemPublicTokenExchange({
      public_token: publicToken,
    })
    const accessToken = exchange.data.access_token
    const itemId = exchange.data.item_id

    // Institution name, for showing the owner which bank is connected.
    let institutionId: string | null = null
    let institutionName: string | null = null
    try {
      const item = await client.itemGet({ access_token: accessToken })
      institutionId = item.data.item.institution_id ?? null
      if (institutionId) {
        const inst = await client.institutionsGetById({
          institution_id: institutionId,
          country_codes: [
            (await import('plaid')).CountryCode.Us,
          ],
        })
        institutionName = inst.data.institution.name ?? null
      }
    } catch {
      // Cosmetic only. A failure here must not lose the access token we just
      // exchanged, so swallow it and carry on with a null name.
    }

    const db = createServiceClient()

    const { error: itemError } = await db.from('plaid_items').upsert(
      {
        item_id: itemId,
        institution_id: institutionId,
        institution_name: institutionName,
        access_token_encrypted: encryptToken(accessToken),
        status: 'active',
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'item_id' },
    )

    if (itemError) {
      throw new Error(`Failed to save the connection: ${itemError.message}`)
    }

    const accounts = await client.accountsGet({ access_token: accessToken })
    const discovered = accounts.data.accounts ?? []

    for (const account of discovered) {
      // Upsert without account_name so re-running Link never clobbers a mapping
      // the owner already configured.
      const { data: existing } = await db
        .from('plaid_accounts')
        .select('id, account_name')
        .eq('account_id', account.account_id)
        .maybeSingle()

      if (existing) continue

      await db.from('plaid_accounts').insert({
        item_id: itemId,
        account_id: account.account_id,
        plaid_name: account.name ?? null,
        mask: account.mask ?? null,
        type: account.type ?? null,
        subtype: account.subtype ?? null,
        // Deliberately null: unmapped until the owner confirms which existing
        // ledger account this is. The sync skips unmapped accounts.
        account_name: null,
        is_enabled: false,
      })
    }

    return Response.json({
      ok: true,
      itemId,
      institutionName,
      accounts: discovered.map((a) => ({
        accountId: a.account_id,
        plaidName: a.name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        suggestedName: suggestAccountName(a.name, a.mask),
      })),
    })
  } catch (error) {
    const message = describePlaidError(error)
    console.log('[v0] plaid/exchange failed:', message)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
