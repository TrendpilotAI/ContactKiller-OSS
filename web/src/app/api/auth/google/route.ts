import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getEncryptionKey } from '@/lib/db/crypto'
import { openSession } from '@/lib/db/session'
import { createOAuthState, OAUTH_STATE_TTL_MS } from '@/lib/oauth-state'

// Google OAuth configuration
const SCOPES = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

// GET /api/auth/google - Initiates Google OAuth flow
export async function GET(): Promise<NextResponse> {
  const session = await openSession()

  // Require authentication
  if (!session) {
    return NextResponse.redirect(new URL('/login?next=/settings', process.env.NEXT_PUBLIC_APP_URL!))
  }
  const userId = String(session.userId.id)
  await session.close()

  // The state is signed for the user who is starting the flow, so only that
  // account can finish it (see completeGoogleCallback). The cookie keeps the
  // flow bound to this browser as well.
  const state = createOAuthState(getEncryptionKey(), userId)

  const cookieStore = await cookies()
  cookieStore.set('google_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: OAUTH_STATE_TTL_MS / 1000,
    path: '/',
  })

  // Build Google OAuth URL
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID!)
  authUrl.searchParams.set('redirect_uri', `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/google/callback`)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  authUrl.searchParams.set('state', state)

  return NextResponse.redirect(authUrl.toString())
}
