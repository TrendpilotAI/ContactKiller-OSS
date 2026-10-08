import { NextRequest, NextResponse } from 'next/server'
import { InvalidCursorError, clampLimit, createContact, getContact, listContacts } from '@/lib/db/contacts'
import { withSession } from '@/lib/db/session'
import { guardRequest } from '@/lib/request-guard'
import { parseNewContact } from '@/lib/contact-input'

// GET /api/contacts - List all contacts
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams

  const filter = searchParams.get('filter')
  const search = searchParams.get('search')
  const cursor = searchParams.get('cursor')
  const limit = Number.parseInt(searchParams.get('limit') || '', 10)

  return withSession(async ({ db }) => {
    try {
      const pageSize = clampLimit(Number.isNaN(limit) ? undefined : limit)
      const contacts = await listContacts(db, { filter, search, cursor, limit: pageSize })
      const nextCursor =
        contacts.length === pageSize ? contacts[contacts.length - 1].updated_at : null

      return NextResponse.json({ contacts, nextCursor })
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
      console.error('Error listing contacts:', error)
      return NextResponse.json({ error: 'Failed to list contacts' }, { status: 500 })
    }
  })
}

// POST /api/contacts - Create a new contact
export async function POST(request: NextRequest) {
  const blocked = guardRequest(request, { json: true })
  if (blocked) return blocked

  return withSession(async ({ db, userId }) => {
    const parsed = parseNewContact(await request.json().catch(() => null))
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    try {
      const id = await createContact(db, userId, parsed.value)
      return NextResponse.json(await getContact(db, id), { status: 201 })
    } catch (error) {
      console.error('Error creating contact:', error)
      return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 })
    }
  })
}
