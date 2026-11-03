import { NextResponse } from 'next/server'
import { openSession } from '@/lib/db/session'

// GET /api/auth/session - Report whether the current cookie is a valid session
export async function GET(): Promise<NextResponse> {
  const session = await openSession()
  if (!session) return NextResponse.json({ authenticated: false })
  await session.close()
  return NextResponse.json({ authenticated: true })
}
