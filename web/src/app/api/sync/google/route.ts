import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncGoogleContacts } from '@/lib/sync/google'

// POST /api/sync/google - Sync contacts from Google
export async function POST(): Promise<NextResponse> {
  const supabase = await createClient()

  // Check authentication
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get Google OAuth token
  const { data: tokenData, error: tokenError } = await supabase
    .from('oauth_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', user.id)
    .eq('provider', 'google')
    .single()

  if (tokenError || !tokenData) {
    return NextResponse.json(
      { error: 'Google not connected. Please connect your Google account first.' },
      { status: 400 }
    )
  }

  // Check if token is expired
  if (new Date(tokenData.expires_at) < new Date()) {
    // TODO: Implement token refresh using refresh_token
    return NextResponse.json(
      { error: 'Google token expired. Please reconnect your Google account.' },
      { status: 401 }
    )
  }

  // Log sync start
  const { data: syncLog } = await supabase
    .from('sync_logs')
    .insert({
      user_id: user.id,
      platform: 'google',
      operation: 'full_sync',
      status: 'started',
    })
    .select('id')
    .single()

  try {
    // Run sync
    const result = await syncGoogleContacts(supabase, user.id, tokenData.access_token)

    // Log sync completion
    if (syncLog) {
      await supabase
        .from('sync_logs')
        .update({
          status: 'completed',
          contacts_processed: result.imported + result.updated,
          conflicts_found: result.conflicts,
          completed_at: new Date().toISOString(),
        })
        .eq('id', syncLog.id)
    }

    return NextResponse.json({
      success: true,
      imported: result.imported,
      updated: result.updated,
      conflicts: result.conflicts,
      errors: result.errors.length > 0 ? result.errors : undefined,
    })

  } catch (err) {
    // Log sync failure
    if (syncLog) {
      await supabase
        .from('sync_logs')
        .update({
          status: 'failed',
          error_message: err instanceof Error ? err.message : 'Unknown error',
          completed_at: new Date().toISOString(),
        })
        .eq('id', syncLog.id)
    }

    console.error('Google sync failed:', err)
    return NextResponse.json(
      { error: 'Sync failed. Please try again.' },
      { status: 500 }
    )
  }
}

// GET /api/sync/google - Check Google connection status
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: tokenData } = await supabase
    .from('oauth_tokens')
    .select('expires_at, created_at')
    .eq('user_id', user.id)
    .eq('provider', 'google')
    .single()

  if (!tokenData) {
    return NextResponse.json({ connected: false })
  }

  const isExpired = new Date(tokenData.expires_at) < new Date()

  return NextResponse.json({
    connected: !isExpired,
    connectedAt: tokenData.created_at,
    expiresAt: tokenData.expires_at,
    needsReauth: isExpired,
  })
}
