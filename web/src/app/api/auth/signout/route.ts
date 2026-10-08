import { NextRequest } from 'next/server'
import { guardRequest } from '@/lib/request-guard'
import { clearSessionCookie } from '@/lib/db/session'

// POST /api/auth/signout - Forget the session cookie. The SurrealDB token is a
// bearer JWT and stays valid until it expires (see docs/CAPABILITIES.md).
export async function POST(request: NextRequest): Promise<Response> {
  const blocked = guardRequest(request)
  if (blocked) return blocked

  await clearSessionCookie()
  return Response.json({ success: true })
}
