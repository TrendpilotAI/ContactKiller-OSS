import { NextRequest, NextResponse } from 'next/server'
import { deleteContact, getContact, updateContact } from '@/lib/db/contacts'
import { InvalidRecordKeyError } from '@/lib/db/client'
import { withSession } from '@/lib/db/session'
import { guardRequest } from '@/lib/request-guard'
import { parseContactPatch } from '@/lib/contact-input'

type RouteContext = { params: Promise<{ id: string }> }

function notFound() {
  return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
}

// GET /api/contacts/:id - Get single contact
export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id } = await params
  return withSession(async ({ db }) => {
    try {
      const contact = await getContact(db, id)
      return contact ? NextResponse.json(contact) : notFound()
    } catch (error) {
      if (error instanceof InvalidRecordKeyError) return notFound()
      throw error
    }
  })
}

// PATCH /api/contacts/:id - Update contact
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const blocked = guardRequest(request, { json: true })
  if (blocked) return blocked
  const { id } = await params

  return withSession(async ({ db }) => {
    const parsed = parseContactPatch(await request.json().catch(() => null))
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    try {
      if (!(await updateContact(db, id, parsed.value))) return notFound()
      return NextResponse.json(await getContact(db, id))
    } catch (error) {
      if (error instanceof InvalidRecordKeyError) return notFound()
      throw error
    }
  })
}

// DELETE /api/contacts/:id - Delete contact
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const blocked = guardRequest(request)
  if (blocked) return blocked
  const { id } = await params
  return withSession(async ({ db }) => {
    try {
      if (!(await deleteContact(db, id))) return notFound()
      return NextResponse.json({ success: true })
    } catch (error) {
      if (error instanceof InvalidRecordKeyError) return notFound()
      throw error
    }
  })
}
