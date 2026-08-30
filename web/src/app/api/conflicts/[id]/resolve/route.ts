import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { redirect } from 'next/navigation'

// POST /api/conflicts/:id/resolve - Resolve a conflict
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const formData = await request.formData()
  const choice = formData.get('choice') as string

  if (!choice || !['a', 'b', 'skip'].includes(choice)) {
    return NextResponse.json(
      { error: 'Invalid choice. Must be "a", "b", or "skip"' },
      { status: 400 }
    )
  }

  // Get the conflict
  const { data: conflict, error: fetchError } = await supabase
    .from('conflicts')
    .select('*')
    .eq('id', id)
    .single()

  if (fetchError || !conflict) {
    return NextResponse.json({ error: 'Conflict not found' }, { status: 404 })
  }

  if (choice === 'skip') {
    // Just mark as resolved without applying
    const { error } = await supabase
      .from('conflicts')
      .update({ resolved: true })
      .eq('id', id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  } else {
    // Apply the chosen value
    const valueToApply = choice === 'a' ? conflict.value_a : conflict.value_b

    // Update the contact field based on conflict.field
    const updateData: Record<string, string | null> = {}
    updateData[conflict.field] = valueToApply

    const { error: updateError } = await supabase
      .from('contacts')
      .update(updateData)
      .eq('id', conflict.contact_id)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    // Mark conflict as resolved
    const { error } = await supabase
      .from('conflicts')
      .update({ resolved: true })
      .eq('id', id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  // Redirect back to conflicts page
  redirect('/conflicts')
}
