import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getEncryptionKey } from '@/lib/db/crypto'
import { saveOAuthToken } from '@/lib/db/oauth-tokens'
import { openSession } from '@/lib/db/session'

// GET /api/auth/google/callback - Handles OAuth callback from Google
export async function GET(request: NextRequest): Promise<NextResponse> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!
  const cookieStore = await cookies()
  const searchParams = request.nextUrl.searchParams

  // Get params from Google
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  // Get stored state
  const storedState = cookieStore.get('google_oauth_state')?.value

  // Clear OAuth cookie immediately
  cookieStore.delete('google_oauth_state')

  // Handle OAuth errors from Google
  if (error) {
    console.error('Google OAuth error:', error)
    return NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(error)}`, appUrl)
    )
  }

  // Validate state (CSRF protection)
  if (!storedState || !state || storedState !== state) {
    console.error('Invalid OAuth state')
    return NextResponse.redirect(new URL('/settings?error=invalid_state', appUrl))
  }

  // The tokens belong to whoever holds the session, never to a user id
  // supplied by the browser.
  const session = await openSession()
  if (!session) {
    return NextResponse.redirect(new URL('/login?next=/settings', appUrl))
  }

  if (!code) {
    await session.close()
    console.error('Missing code')
    return NextResponse.redirect(new URL('/settings?error=missing_params', appUrl))
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${appUrl}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text()
      console.error('Token exchange failed:', errorData)
      return NextResponse.redirect(new URL('/settings?error=token_exchange_failed', appUrl))
    }

    const tokens = await tokenResponse.json()

    // Store tokens in SurrealDB, encrypted, scoped to the session user
    try {
      await saveOAuthToken(session.db, getEncryptionKey(), session.userId, 'google', {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      })
    } catch (storeError) {
      console.error('Failed to store tokens:', storeError)
      return NextResponse.redirect(new URL('/settings?error=storage_failed', appUrl))
    }

    // Success - redirect to settings with success message
    return NextResponse.redirect(new URL('/settings?google=connected', appUrl))
  } catch (err) {
    console.error('OAuth callback error:', err)
    return NextResponse.redirect(new URL('/settings?error=callback_failed', appUrl))
  } finally {
    await session.close()
  }
}
