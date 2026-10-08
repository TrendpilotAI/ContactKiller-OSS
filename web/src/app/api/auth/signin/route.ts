import { NextRequest, NextResponse } from 'next/server'
import { AUTH_ERROR_MESSAGES, AuthError, signIn } from '@/lib/db/auth'
import { getSurrealConfig } from '@/lib/db/config'
import { setSessionCookie } from '@/lib/db/session'

// POST /api/auth/signin - Exchange credentials for a SurrealDB session token
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null)
  try {
    const token = await signIn(getSurrealConfig(), body?.email, body?.password)
    await setSessionCookie(token)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: AUTH_ERROR_MESSAGES[error.code], code: error.code }, { status: 401 })
    }
    console.error('Sign-in failed:', error)
    return NextResponse.json({ error: 'Sign-in failed. Is SurrealDB running?' }, { status: 503 })
  }
}
