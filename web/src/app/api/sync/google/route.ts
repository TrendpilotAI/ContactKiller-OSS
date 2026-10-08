import { NextResponse } from 'next/server'
import { getEncryptionKey } from '@/lib/db/crypto'
import { getOAuthStatus, getOAuthToken } from '@/lib/db/oauth-tokens'
import { withSession } from '@/lib/db/session'
import { finishSyncLog, startSyncLog } from '@/lib/db/sync-logs'
import { syncGoogleContacts } from '@/lib/sync/google'

// POST /api/sync/google - Sync contacts from Google
export async function POST(): Promise<Response> {
  return withSession(async ({ db, userId }) => {
    // Get Google OAuth token
    const tokenData = await getOAuthToken(db, getEncryptionKey(), userId, 'google')

    if (!tokenData) {
      return NextResponse.json(
        { error: 'Google not connected. Please connect your Google account first.' },
        { status: 400 }
      )
    }

    // Check if token is expired
    if (tokenData.expiresAt < new Date()) {
      // TODO: Implement token refresh using refresh_token
      return NextResponse.json(
        { error: 'Google token expired. Please reconnect your Google account.' },
        { status: 401 }
      )
    }

    // Log sync start
    const syncLogId = await startSyncLog(db, userId, 'google', 'full_sync')

    try {
      // Run sync
      const result = await syncGoogleContacts(db, userId, tokenData.accessToken)

      // Log sync completion
      await finishSyncLog(db, syncLogId, {
        status: 'completed',
        contactsProcessed: result.imported + result.updated,
        conflictsFound: result.conflicts,
      })

      return NextResponse.json({
        success: true,
        imported: result.imported,
        updated: result.updated,
        conflicts: result.conflicts,
        errors: result.errors.length > 0 ? result.errors : undefined,
      })
    } catch (err) {
      // Log sync failure
      await finishSyncLog(db, syncLogId, {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      }).catch((logError) => console.error('Failed to record sync failure:', logError))

      console.error('Google sync failed:', err)
      return NextResponse.json(
        { error: 'Sync failed. Please try again.' },
        { status: 500 }
      )
    }
  })
}

// GET /api/sync/google - Check Google connection status
export async function GET(): Promise<Response> {
  return withSession(async ({ db }) => {
    const status = await getOAuthStatus(db, 'google')

    if (!status) {
      return NextResponse.json({ connected: false })
    }

    const isExpired = status.expiresAt < new Date()

    return NextResponse.json({
      connected: !isExpired,
      connectedAt: status.createdAt.toISOString(),
      expiresAt: status.expiresAt.toISOString(),
      needsReauth: isExpired,
    })
  })
}
