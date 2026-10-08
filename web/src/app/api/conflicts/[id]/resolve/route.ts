import { NextRequest, NextResponse } from 'next/server'
import { redirect } from 'next/navigation'
import { InvalidRecordKeyError } from '@/lib/db/client'
import { isChoice, resolveConflict } from '@/lib/db/conflicts'
import { openSession, unauthorizedResponse } from '@/lib/db/session'

// POST /api/conflicts/:id/resolve - Resolve a conflict
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const formData = await request.formData()
  const choice = formData.get('choice')

  if (!isChoice(choice)) {
    return NextResponse.json(
      { error: 'Invalid choice. Must be "a", "b", or "skip"' },
      { status: 400 }
    )
  }

  const session = await openSession()
  if (!session) return unauthorizedResponse()

  let outcome
  try {
    outcome = await resolveConflict(session.db, id, choice)
  } catch (error) {
    if (!(error instanceof InvalidRecordKeyError)) throw error
    outcome = { status: 'not_found' as const }
  } finally {
    await session.close()
  }

  switch (outcome.status) {
    case 'resolved':
      // Redirect back to conflicts page
      redirect('/conflicts')
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
