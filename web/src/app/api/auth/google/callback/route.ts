import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'

// Google OAuth configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const GOOGLE_REDIRECT_URI = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/google/callback`

// GET /api/auth/google/callback - Handles OAuth callback from Google
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cookieStore = await cookies()
  const searchParams = request.nextUrl.searchParams

  // Get params from Google
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  // Get stored state and user ID
  const storedState = cookieStore.get('google_oauth_state')?.value
  const userId = cookieStore.get('google_oauth_user')?.value

  // Clear OAuth cookies immediately
  cookieStore.delete('google_oauth_state')
  cookieStore.delete('google_oauth_user')

  // Handle OAuth errors from Google
  if (error) {
    console.error('Google OAuth error:', error)
    return NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(error)}`, process.env.NEXT_PUBLIC_APP_URL!)
    )
  }

  // Validate state (CSRF protection)
  if (!storedState || !state || storedState !== state) {
    console.error('Invalid OAuth state')
    return NextResponse.redirect(
      new URL('/settings?error=invalid_state', process.env.NEXT_PUBLIC_APP_URL!)
    )
  }

  // Validate we have code and user ID
  if (!code || !userId) {
    console.error('Missing code or user ID')
    return NextResponse.redirect(
      new URL('/settings?error=missing_params', process.env.NEXT_PUBLIC_APP_URL!)
    )
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text()
      console.error('Token exchange failed:', errorData)
      return NextResponse.redirect(
        new URL('/settings?error=token_exchange_failed', process.env.NEXT_PUBLIC_APP_URL!)
      )
    }

    const tokens = await tokenResponse.json()

    // Store tokens in Supabase (RLS protected)
    const supabase = await createClient()
    const { error: upsertError } = await supabase
      .from('oauth_tokens')
      .upsert({
        user_id: userId,
        provider: 'google',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      }, {
        onConflict: 'user_id,provider',
      })

    if (upsertError) {
      console.error('Failed to store tokens:', upsertError)
      return NextResponse.redirect(
        new URL('/settings?error=storage_failed', process.env.NEXT_PUBLIC_APP_URL!)
      )
    }

    // Success - redirect to settings with success message
    return NextResponse.redirect(
      new URL('/settings?google=connected', process.env.NEXT_PUBLIC_APP_URL!)
    )

  } catch (err) {
    console.error('OAuth callback error:', err)
    return NextResponse.redirect(
      new URL('/settings?error=callback_failed', process.env.NEXT_PUBLIC_APP_URL!)
    )
  }
}
