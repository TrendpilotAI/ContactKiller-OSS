import type { RecordId } from 'surrealdb'
import type { Db } from '@/lib/db/client'
import { saveOAuthToken } from '@/lib/db/oauth-tokens'
import { verifyOAuthState } from '@/lib/oauth-state'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

export type GoogleCallbackOutcome =
  | { status: 'connected' }
  | { status: 'invalid_state' }
  | { status: 'missing_params' }
  | { status: 'token_exchange_failed' }
  | { status: 'storage_failed' }
  | { status: 'callback_failed' }

export interface GoogleCallbackInput {
  db: Db
  // The user whose session is completing the callback.
  userId: RecordId
  secret: Buffer
  // `state` from Google's redirect, and the one kept in this browser's cookie.
  state: string | null
  cookieState: string | undefined
  code: string | null
  redirectUri: string
  clientId: string
  clientSecret: string
  fetchImpl?: typeof fetch
  now?: Date
}

// Completes the Google consent flow for the signed-in user. The flow must have
// been started by that same user: the CSRF check (state equals the browser's
// cookie) and the account binding (the state is signed for this user and not
// expired) both run before Google is asked for tokens, and when either fails
// nothing is exchanged and nothing is stored.
export async function completeGoogleCallback(input: GoogleCallbackInput): Promise<GoogleCallbackOutcome> {
  const { state, cookieState } = input
  if (!cookieState || !state || cookieState !== state) return { status: 'invalid_state' }
  if (!verifyOAuthState(input.secret, state, String(input.userId.id), input.now)) {
    return { status: 'invalid_state' }
  }
  if (!input.code) return { status: 'missing_params' }

  try {
    const tokenResponse = await (input.fetchImpl ?? fetch)(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    if (!tokenResponse.ok) {
      console.error('Token exchange failed with status', tokenResponse.status)
      return { status: 'token_exchange_failed' }
    }
    const tokens = await tokenResponse.json()

    try {
      await saveOAuthToken(input.db, input.secret, input.userId, 'google', {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: new Date((input.now ?? new Date()).getTime() + tokens.expires_in * 1000),
      })
    } catch (storeError) {
      console.error('Failed to store tokens:', storeError)
      return { status: 'storage_failed' }
    }
    return { status: 'connected' }
  } catch (err) {
    console.error('OAuth callback error:', err)
    return { status: 'callback_failed' }
  }
}
