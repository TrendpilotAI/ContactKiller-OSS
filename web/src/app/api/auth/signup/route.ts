import { NextRequest, NextResponse } from 'next/server'
import { guardRequest } from '@/lib/request-guard'
import { AUTH_ERROR_MESSAGES, AuthError, signUp } from '@/lib/db/auth'
import { getSurrealConfig, isSignupEnabled } from '@/lib/db/config'
import { setSessionCookie } from '@/lib/db/session'

// POST /api/auth/signup - Create a ContactKiller account in SurrealDB
export async function POST(request: NextRequest): Promise<Response> {
  const blocked = guardRequest(request, { json: true })
  if (blocked) return blocked

  if (!isSignupEnabled()) {
    return NextResponse.json({ error: 'Sign-up is disabled on this instance.' }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  try {
    const token = await signUp(getSurrealConfig(), body?.email, body?.password)
    await setSessionCookie(token)
    return NextResponse.json({ success: true }, { status: 201 })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: AUTH_ERROR_MESSAGES[error.code], code: error.code },
        { status: error.code === 'signup_disabled' ? 403 : 400 })
    }
    console.error('Sign-up failed:', error)
    return NextResponse.json({ error: 'Sign-up failed. Is SurrealDB running?' }, { status: 503 })
  }
}
