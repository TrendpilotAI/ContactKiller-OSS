import { NextRequest, NextResponse } from 'next/server'
import { redirect } from 'next/navigation'
import { InvalidRecordKeyError } from '@/lib/db/client'
import { isChoice, resolveConflict, type ResolveOutcome } from '@/lib/db/conflicts'
import { openSession, unauthorizedResponse } from '@/lib/db/session'
import { MAX_FORM_BYTES, guardRequest, readLimitedFormData } from '@/lib/request-guard'

// POST /api/conflicts/:id/resolve - Resolve a conflict
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const blocked = guardRequest(request)
  if (blocked) return blocked
  const { id } = await params

  const session = await openSession()
  if (!session) return unauthorizedResponse()

  // Everything that touches the session or the body stays inside try/finally so
  // the connection is released on every path, including a failed body read.
  let outcome: ResolveOutcome | { status: 'invalid_choice' }
  try {
    const formData = await readLimitedFormData(request, MAX_FORM_BYTES)
    const choice = formData?.get('choice')
    if (!isChoice(choice)) {
      outcome = { status: 'invalid_choice' }
    } else {
      try {
        outcome = await resolveConflict(session.db, id, choice)
      } catch (error) {
        if (!(error instanceof InvalidRecordKeyError)) throw error
        outcome = { status: 'not_found' }
      }
    }
  } finally {
    await session.close()
  }

  switch (outcome.status) {
    case 'resolved':
      // Redirect back to conflicts page
      redirect('/conflicts')
    case 'invalid_choice':
      return NextResponse.json(
        { error: 'Invalid choice. Must be "a", "b", or "skip"' },
        { status: 400 }
      )
    case 'not_found':
      return NextResponse.json({ error: 'Conflict not found' }, { status: 404 })
    case 'already_resolved':
      return NextResponse.json({ error: 'Conflict is already resolved' }, { status: 409 })
    case 'unsupported_field':
      return NextResponse.json(
        { error: `Conflicts on "${outcome.field}" cannot be applied automatically. Choose skip.` },
        { status: 422 }
      )
    default: {
      const unreachable: never = outcome
      return unreachable
    }
  }
}
