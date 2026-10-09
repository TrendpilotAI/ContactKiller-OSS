import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const VERSION = 'v1'
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
const DERIVATION_LABEL = 'contactkiller/oauth-state/v1'

// The signing key is derived from the application secret rather than used
// directly, so the token-encryption key is never also an HMAC key.
function signingKey(secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(DERIVATION_LABEL).digest()
}

function sign(secret: Buffer, nonce: string, issuedAt: string, userId: string): Buffer {
  return createHmac('sha256', signingKey(secret))
    .update([VERSION, nonce, issuedAt, userId].join('\n'))
    .digest()
}

// `state` for Google's consent redirect: a random nonce, the time it was
// issued, and an HMAC over both plus the id of the user who started the flow.
// The nonce still gives the browser-bound CSRF check (it is also kept in an
// httpOnly cookie); the MAC additionally pins the flow to one account, so a
// callback arriving under a different session cannot complete it.
export function createOAuthState(secret: Buffer, userId: string, now: Date = new Date()): string {
  const nonce = randomBytes(24).toString('base64url')
  const issuedAt = String(now.getTime())
  const mac = sign(secret, nonce, issuedAt, userId).toString('base64url')
  return [VERSION, nonce, issuedAt, mac].join('.')
}

// True only for an unexpired state that was issued for exactly this user by
// this application. Anything malformed, from the old unsigned format, or signed
// for another account is false.
export function verifyOAuthState(
  secret: Buffer,
  state: string | null | undefined,
  userId: string,
  now: Date = new Date()
): boolean {
  if (typeof state !== 'string') return false
  const parts = state.split('.')
  if (parts.length !== 4) return false
  const [version, nonce, issuedAt, mac] = parts
  if (version !== VERSION || !nonce || !/^\d{1,16}$/.test(issuedAt) || !mac) return false

  const age = now.getTime() - Number(issuedAt)
  if (age < 0 || age > OAUTH_STATE_TTL_MS) return false

  const given = Buffer.from(mac, 'base64url')
  const expected = sign(secret, nonce, issuedAt, userId)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
