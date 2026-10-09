import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { AuthenticationError, NotAllowedError, RecordId } from 'surrealdb'
import { SESSION_MAX_AGE_SECONDS } from './auth'
import { connect, type Db } from './client'
import { getSurrealConfig } from './config'

export const SESSION_COOKIE = 'ck_session'

export interface UserSession {
  db: Db
  userId: RecordId
  close(): Promise<void>
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
  })
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE)
}

// Returns null when there is no cookie or SurrealDB rejects the token (expired,
// tampered, or issued for another namespace/database).
export async function openSession(): Promise<UserSession | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null

  let db: Db
  try {
    db = await connect(getSurrealConfig(), { kind: 'token', token })
  } catch (error) {
    if (isAuthRejection(error)) return null
    throw error
  }

  const close = async () => {
    await db.close().catch(() => undefined)
  }
  try {
    const [auth] = await db.query('RETURN $auth').collect<[RecordId | null | undefined]>()
    if (!(auth instanceof RecordId) || auth.table.name !== 'app_user') {
      await close()
      return null
    }
    return { db, userId: auth, close }
  } catch (error) {
    await close()
    if (isAuthRejection(error)) return null
    throw error
  }
}

function isAuthRejection(error: unknown): boolean {
  return error instanceof NotAllowedError || error instanceof AuthenticationError
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

// For API routes: runs the handler with an authenticated session, or answers
// 401. The connection is always closed.
export async function withSession(
  handler: (session: UserSession) => Promise<Response>
): Promise<Response> {
  const session = await openSession()
  if (!session) return unauthorizedResponse()
  try {
    return await handler(session)
  } finally {
    await session.close()
  }
}

// For server components: redirects to the login screen when unauthenticated.
export async function requireSession(nextPath: string): Promise<UserSession> {
  const session = await openSession()
  if (!session) redirect(`/login?next=${encodeURIComponent(nextPath)}`)
  return session
}
