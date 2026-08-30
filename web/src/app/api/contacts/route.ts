import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/contacts - List all contacts
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const searchParams = request.nextUrl.searchParams

  const filter = searchParams.get('filter')
  const search = searchParams.get('search')
  const cursor = searchParams.get('cursor')
  const limit = parseInt(searchParams.get('limit') || '100')

  let query = supabase
    .from('contacts')
    .select(`
      *,
      emails (*),
      phones (*),
      platform_links (*)
    `)
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (filter === 'personal') {
    query = query.eq('is_financial_advisor', false)
  } else if (filter === 'fa') {
    query = query.eq('is_financial_advisor', true)
  }

  if (search) {
    query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%`)
  }

  if (cursor) {
    query = query.lt('updated_at', cursor)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const nextCursor = data.length === limit ? data[data.length - 1].updated_at : null

  return NextResponse.json({
    contacts: data,
    nextCursor,
  })
}

// POST /api/contacts - Create a new contact
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()

  const { first_name, last_name, is_financial_advisor, emails, phones } = body

  // Create contact
  const { data: contact, error: contactError } = await supabase
    .from('contacts')
    .insert({
      first_name,
      last_name,
      is_financial_advisor: is_financial_advisor || false,
    })
    .select()
    .single()

  if (contactError) {
    return NextResponse.json({ error: contactError.message }, { status: 500 })
  }

  // Add emails
  if (emails && emails.length > 0) {
    const { error: emailError } = await supabase
      .from('emails')
      .insert(
        emails.map((e: { email: string; label?: string }) => ({
          contact_id: contact.id,
          email: e.email,
          label: e.label,
        }))
      )

    if (emailError) {
      console.error('Error adding emails:', emailError)
    }
  }

  // Add phones
  if (phones && phones.length > 0) {
    const { error: phoneError } = await supabase
      .from('phones')
      .insert(
        phones.map((p: { phone: string; label?: string }) => ({
          contact_id: contact.id,
          phone: p.phone,
          label: p.label,
        }))
      )

    if (phoneError) {
      console.error('Error adding phones:', phoneError)
    }
  }

  // Fetch full contact with relations
  const { data: fullContact } = await supabase
    .from('contacts')
    .select(`
      *,
      emails (*),
      phones (*),
      platform_links (*)
    `)
    .eq('id', contact.id)
    .single()

  return NextResponse.json(fullContact, { status: 201 })
}
