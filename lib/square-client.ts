/**
 * Server-only Square API access.
 *
 * The access token is a bearer credential for live financial data, so it is
 * read from the environment and never exposed to the browser. `server-only`
 * makes an accidental client import a build error instead of a token leak.
 */
import 'server-only'
import { SquareClient, SquareEnvironment } from 'square'

export type SquareConfigState =
  | { configured: false; reason: string }
  | { configured: true; environment: 'production' | 'sandbox' }

/**
 * Whether Square credentials exist, without making a network call.
 *
 * Used by pages to render an honest "not connected" state rather than showing
 * zeros that look like real sales of $0.
 */
export function getSquareConfigState(): SquareConfigState {
  const token = process.env.SQUARE_ACCESS_TOKEN
  if (!token || !token.trim()) {
    return {
      configured: false,
      reason: 'SQUARE_ACCESS_TOKEN is not set.',
    }
  }
  return { configured: true, environment: resolveEnvironment() }
}

function resolveEnvironment(): 'production' | 'sandbox' {
  const raw = (process.env.SQUARE_ENVIRONMENT || '').trim().toLowerCase()
  if (raw === 'sandbox') return 'sandbox'
  return 'production'
}

/**
 * Build a Square client, or throw a message worth showing to the owner.
 *
 * Throwing beats returning null: every caller needs a token, and a null would
 * only surface later as an unhelpful "cannot read property of null".
 */
export function getSquareClient(): SquareClient {
  const token = process.env.SQUARE_ACCESS_TOKEN
  if (!token || !token.trim()) {
    throw new SquareNotConfiguredError(
      'Square is not connected. Add SQUARE_ACCESS_TOKEN in project settings.',
    )
  }
  return new SquareClient({
    token: token.trim(),
    environment:
      resolveEnvironment() === 'sandbox'
        ? SquareEnvironment.Sandbox
        : SquareEnvironment.Production,
  })
}

export class SquareNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SquareNotConfiguredError'
  }
}

/**
 * Turn any Square/network failure into a short sentence for the UI.
 *
 * Square's errors arrive in several shapes (SDK error objects, arrays of API
 * errors, plain network errors). Auth failures are called out explicitly since
 * "check your token" is actionable, whereas a raw 401 body is not.
 */
export function describeSquareError(error: unknown): string {
  if (error instanceof SquareNotConfiguredError) return error.message

  const anyErr = error as {
    statusCode?: number
    message?: string
    errors?: { code?: string; detail?: string; category?: string }[]
    body?: { errors?: { code?: string; detail?: string }[] }
  }

  const apiErrors = anyErr?.errors ?? anyErr?.body?.errors
  if (Array.isArray(apiErrors) && apiErrors.length > 0) {
    const first = apiErrors[0]
    const detail = first.detail || first.code || 'Unknown Square error'
    if (
      first.code === 'UNAUTHORIZED' ||
      first.code === 'ACCESS_TOKEN_EXPIRED' ||
      first.code === 'ACCESS_TOKEN_REVOKED'
    ) {
      return `Square rejected the access token (${first.code}). Generate a new token and update SQUARE_ACCESS_TOKEN.`
    }
    if (first.code === 'FORBIDDEN' || first.code === 'INSUFFICIENT_SCOPES') {
      return `The Square token is missing required permissions (${first.code}). It needs read access to Orders, Payments, Items and Team.`
    }
    return detail
  }

  const status = anyErr?.statusCode
  if (status === 401) {
    return 'Square rejected the access token (401). Generate a new token and update SQUARE_ACCESS_TOKEN.'
  }
  if (status === 403) {
    return 'The Square token lacks the required read permissions (403).'
  }
  if (status === 429) {
    return 'Square rate limited the request (429). Wait a moment and sync again.'
  }

  if (anyErr?.message) return anyErr.message
  return 'Unexpected error talking to Square.'
}

export type ConnectionTestResult =
  | {
      ok: true
      environment: 'production' | 'sandbox'
      locations: { id: string; name: string; currency: string | null; timezone: string | null }[]
    }
  | { ok: false; error: string }

/**
 * Verify the token by listing locations — the cheapest authenticated call.
 *
 * Proves the token is valid AND has read access before the owner waits on a
 * full historical sync.
 */
export async function testSquareConnection(): Promise<ConnectionTestResult> {
  try {
    const client = getSquareClient()
    const response = await client.locations.list()
    const locations = (response.locations ?? []).map((l) => ({
      id: l.id ?? '',
      name: l.name ?? 'Unnamed location',
      currency: l.currency ?? null,
      timezone: l.timezone ?? null,
    }))
    return { ok: true, environment: resolveEnvironment(), locations }
  } catch (error) {
    return { ok: false, error: describeSquareError(error) }
  }
}

/**
 * Retry helper for transient failures.
 *
 * Only retries rate limits and 5xx — a 401 or 403 will fail identically on
 * every attempt, so retrying those just delays the real error message.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 500 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const status = (error as { statusCode?: number })?.statusCode
      const retryable = status === 429 || (typeof status === 'number' && status >= 500)
      if (!retryable || i === attempts - 1) throw error
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i))
    }
  }
  throw lastError
}
