import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/contacts/bulk-tag - Tag multiple contacts
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()

  const { ids, is_financial_advisor } = body

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: 'ids array is required' },
      { status: 400 }
    )
  }

  const { data, error } = await supabase
    .from('contacts')
    .update({ is_financial_advisor })
    .in('id', ids)
    .select()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    updated: data.length,
    contacts: data,
  })
}
