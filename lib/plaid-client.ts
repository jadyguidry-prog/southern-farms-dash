import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'

/**
 * Plaid credentials, resolved at call time.
 *
 * Mirrors lib/square-client.ts: never throw at module scope, so a project without
 * Plaid configured still builds, renders, and runs every other page. The Settings
 * panel asks `isPlaidConfigured()` and shows setup instructions instead of an
 * error when the keys are absent.
 */
export type PlaidEnv = 'sandbox' | 'production'

export function plaidEnv(): PlaidEnv {
  // Default to sandbox. Production moves real money-adjacent data, so it must be
  // opted into explicitly rather than being the fallback for a typo.
  return process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox'
}

export function isPlaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET)
}

/**
 * The registered OAuth redirect URI, or null when not configured.
 *
 * Required for OAuth institutions, which now includes **American Express** —
 * credential-based login is unavailable for banks that have migrated to OAuth, so
 * without this the Amex card simply cannot be linked. Plaid sends the owner to the
 * bank's own site, and the bank returns them to this exact URI.
 *
 * The value must match the entry in the Plaid Dashboard (Developers > API >
 * Allowed redirect URIs) character for character, including `www` and any path, and
 * must be HTTPS in production. A mismatch surfaces as `INVALID_FIELD` at link-token
 * creation rather than at the moment of redirect.
 *
 * Optional on purpose: non-OAuth institutions link fine without it, so a missing
 * value must not break the whole panel.
 */
export function plaidRedirectUri(): string | null {
  const raw = process.env.PLAID_REDIRECT_URI?.trim()
  if (!raw) return null
  // A trailing slash or stray quote is a config typo that Plaid rejects with a
  // confusing error, so normalise the cheap cases here.
  return raw.replace(/^['"]|['"]$/g, '')
}

/**
 * True once a 32-byte encryption key is present. Access tokens are long-lived
 * bank credentials, so we refuse to store them without one rather than writing
 * them in the clear.
 */
export function isPlaidEncryptionConfigured(): boolean {
  return Boolean(process.env.PLAID_ENCRYPTION_KEY)
}

let cached: PlaidApi | null = null

export function plaidClient(): PlaidApi {
  if (cached) return cached

  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  if (!clientId || !secret) {
    throw new Error(
      'Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET.',
    )
  }

  cached = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[plaidEnv()],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': clientId,
          'PLAID-SECRET': secret,
        },
      },
    }),
  )
  return cached
}

/**
 * Pull the useful part out of a Plaid SDK error.
 *
 * Plaid returns its detail inside `error.response.data`, which stringifies to
 * `[object Object]` through a plain `String(err)` — the sync's status column would
 * record nothing actionable. `error_code` is the field worth surfacing:
 * `ITEM_LOGIN_REQUIRED` means the owner must re-authenticate,
 * `INSTITUTION_REGISTRATION_REQUIRED` means Amex OAuth registration is incomplete.
 */
export function describePlaidError(err: unknown): string {
  const data = (err as { response?: { data?: Record<string, unknown> } })
    ?.response?.data
  if (data && typeof data === 'object') {
    const code = data.error_code ?? data.error_type
    const message = data.error_message ?? ''
    if (code) return `${String(code)}: ${String(message)}`.trim()
  }
  return err instanceof Error ? err.message : String(err)
}

/** Plaid error codes that mean "the owner must reconnect this bank by hand". */
const REAUTH_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'ITEM_LOCKED',
])

export function needsReauth(err: unknown): boolean {
  const code = (err as { response?: { data?: { error_code?: string } } })
    ?.response?.data?.error_code
  return code ? REAUTH_CODES.has(code) : false
}
