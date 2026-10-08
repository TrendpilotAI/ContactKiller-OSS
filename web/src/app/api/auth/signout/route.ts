import { NextResponse } from 'next/server'
import { clearSessionCookie } from '@/lib/db/session'

// POST /api/auth/signout - Forget the session cookie
export async function POST(): Promise<NextResponse> {
  await clearSessionCookie()
  return NextResponse.json({ success: true })
}
