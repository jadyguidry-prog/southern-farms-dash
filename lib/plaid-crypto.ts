import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'node:crypto'

/**
 * Authenticated encryption for Plaid access tokens.
 *
 * A Plaid access token is a long-lived credential that can read the farm's full
 * bank and card history. The database already holds no other secret of this kind,
 * so tokens are encrypted at rest with AES-256-GCM: even a leaked table dump
 * yields nothing without PLAID_ENCRYPTION_KEY, which lives only in the
 * environment.
 *
 * GCM (not CBC) so that tampering is detected on decrypt rather than silently
 * producing garbage that we would then send to Plaid as if it were a token.
 *
 * Stored format: `v1.<iv-base64>.<authTag-base64>.<ciphertext-base64>`. The
 * version prefix means the scheme can be rotated later without guessing at how
 * existing rows were written.
 */
const VERSION = 'v1'
const IV_BYTES = 12 // 96-bit nonce, the GCM standard

function keyBytes(): Buffer {
  const raw = process.env.PLAID_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'PLAID_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32',
    )
  }

  // Accept either a base64 32-byte key (preferred) or any passphrase. A
  // passphrase is hashed to exactly 32 bytes so a short value cannot produce an
  // undersized key and crash createCipheriv at runtime.
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length === 32) return decoded
  return createHash('sha256').update(raw, 'utf8').digest()
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.')
}

export function decryptToken(stored: string): string {
  const parts = stored.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(
      'Stored Plaid token is not in the expected encrypted format. Reconnect the institution to re-issue it.',
    )
  }

  const [, ivB64, tagB64, dataB64] = parts
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyBytes(),
    Buffer.from(ivB64, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * Last 4 characters, for showing "which token is this" in logs or Settings
 * without ever rendering the credential itself.
 */
export function tokenHint(plain: string): string {
  return plain.length <= 4 ? '****' : `****${plain.slice(-4)}`
}
