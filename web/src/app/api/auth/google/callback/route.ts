import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getEncryptionKey } from '@/lib/db/crypto'
import { openSession } from '@/lib/db/session'
import { completeGoogleCallback, type GoogleCallbackOutcome } from '@/lib/sync/google-oauth'

const ERROR_CODES: Record<Exclude<GoogleCallbackOutcome['status'], 'connected'>, string> = {
  invalid_state: 'invalid_state',
  missing_params: 'missing_params',
  token_exchange_failed: 'token_exchange_failed',
  storage_failed: 'storage_failed',
  callback_failed: 'callback_failed',
}

// GET /api/auth/google/callback - Handles OAuth callback from Google
export async function GET(request: NextRequest): Promise<NextResponse> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!
  const cookieStore = await cookies()
  const searchParams = request.nextUrl.searchParams

  // Get params from Google
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  // Get stored state, then clear it: a state is good for one callback
  const cookieState = cookieStore.get('google_oauth_state')?.value
  cookieStore.delete('google_oauth_state')

  // Handle OAuth errors from Google
  if (error) {
    console.error('Google OAuth error:', error)
    return NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(error)}`, appUrl)
    )
  }

  // The tokens belong to whoever holds the session, never to a user id
  // supplied by the browser, and only if that same user started the flow.
  const session = await openSession()
  if (!session) {
    return NextResponse.redirect(new URL('/login?next=/settings', appUrl))
  }

  let outcome: GoogleCallbackOutcome
  try {
    outcome = await completeGoogleCallback({
      db: session.db,
      userId: session.userId,
      secret: getEncryptionKey(),
      state,
      cookieState,
      code,
      redirectUri: `${appUrl}/api/auth/google/callback`,
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    })
  } finally {
    await session.close()
  }

  if (outcome.status === 'connected') {
    return NextResponse.redirect(new URL('/settings?google=connected', appUrl))
  }
  return NextResponse.redirect(new URL(`/settings?error=${ERROR_CODES[outcome.status]}`, appUrl))
}
