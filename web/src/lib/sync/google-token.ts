import type { RecordId } from 'surrealdb'
import type { Db } from '@/lib/db/client'
import { TokenDecryptError, getOAuthToken, saveOAuthToken } from '@/lib/db/oauth-tokens'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
// Refresh slightly early so a sync does not start with a token about to lapse.
const EXPIRY_MARGIN_MS = 60_000

export type GoogleTokenResult =
  | { status: 'ok'; accessToken: string }
  | { status: 'not_connected' }
  // The user must run the Google connect flow again.
  | { status: 'reconnect' }
  // Google could not be reached or answered unexpectedly; retrying may work.
  | { status: 'refresh_unavailable' }

export interface GoogleTokenDeps {
  fetchImpl?: typeof fetch
  now?: () => Date
  clientId?: string
  clientSecret?: string
}

// Returns a usable Google access token for the user, refreshing it with the
// stored refresh token when it has expired.
export async function getUsableGoogleToken(
  db: Db,
  key: Buffer,
  owner: RecordId,
  deps: GoogleTokenDeps = {}
): Promise<GoogleTokenResult> {
  const now = (deps.now ?? (() => new Date()))()

  let stored
  try {
    stored = await getOAuthToken(db, key, owner, 'google')
  } catch (error) {
    if (error instanceof TokenDecryptError) return { status: 'reconnect' }
    throw error
  }
  if (!stored) return { status: 'not_connected' }
  if (stored.expiresAt.getTime() - EXPIRY_MARGIN_MS > now.getTime()) {
    return { status: 'ok', accessToken: stored.accessToken }
  }
  if (!stored.refreshToken) return { status: 'reconnect' }

  const clientId = deps.clientId ?? process.env.GOOGLE_CLIENT_ID
  const clientSecret = deps.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required to refresh Google tokens.')
  }

  let response: Response
  try {
    response = await (deps.fetchImpl ?? fetch)(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: stored.refreshToken,
        grant_type: 'refresh_token',
      }),
    })
  } catch {
    return { status: 'refresh_unavailable' }
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    // Revoked or expired refresh tokens cannot be recovered without consent.
    return body?.error === 'invalid_grant' ? { status: 'reconnect' } : { status: 'refresh_unavailable' }
  }

  const refreshed = await response.json().catch(() => null)
  if (typeof refreshed?.access_token !== 'string' || typeof refreshed?.expires_in !== 'number') {
    return { status: 'refresh_unavailable' }
  }

  // Google normally omits refresh_token here; the stored one is kept unless a
  // new one is supplied.
  await saveOAuthToken(db, key, owner, 'google', {
    accessToken: refreshed.access_token,
    refreshToken: typeof refreshed.refresh_token === 'string' ? refreshed.refresh_token : null,
    expiresAt: new Date(now.getTime() + refreshed.expires_in * 1000),
  })
  return { status: 'ok', accessToken: refreshed.access_token }
}
