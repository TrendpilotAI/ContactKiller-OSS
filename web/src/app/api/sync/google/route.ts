import { NextRequest, NextResponse } from 'next/server'
import { guardRequest } from '@/lib/request-guard'
import { getEncryptionKey } from '@/lib/db/crypto'
import { getOAuthStatus } from '@/lib/db/oauth-tokens'
import { withSession } from '@/lib/db/session'
import { finishSyncLog, startSyncLog } from '@/lib/db/sync-logs'
import { syncGoogleContacts } from '@/lib/sync/google'
import { getUsableGoogleToken } from '@/lib/sync/google-token'

const RECONNECT_BODY = {
  error: 'Google token expired or unreadable. Please reconnect your Google account.',
}

// POST /api/sync/google - Sync contacts from Google
export async function POST(request: NextRequest): Promise<Response> {
  const blocked = guardRequest(request)
  if (blocked) return blocked

  return withSession(async ({ db, userId }) => {
    // Get a usable Google token, refreshing it when it has expired
    const token = await getUsableGoogleToken(db, getEncryptionKey(), userId)

    switch (token.status) {
      case 'ok':
        break
      case 'not_connected':
        return NextResponse.json(
          { error: 'Google not connected. Please connect your Google account first.' },
          { status: 400 }
        )
      case 'reconnect':
        return NextResponse.json(RECONNECT_BODY, { status: 401 })
      case 'refresh_unavailable':
        return NextResponse.json(
          { error: 'Could not refresh the Google token. Please try again.' },
          { status: 502 }
        )
      default: {
        const unreachable: never = token
        return unreachable
      }
    }

    // Log sync start
    const syncLogId = await startSyncLog(db, userId, 'google', 'full_sync')

    try {
      // Run sync
      const result = await syncGoogleContacts(db, userId, token.accessToken)

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
        skipped: result.skipped.length > 0 ? result.skipped : undefined,
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
    // An expired access token with a refresh token is renewed on the next sync.
    const needsReauth = isExpired && !status.hasRefreshToken

    return NextResponse.json({
      connected: !needsReauth,
      connectedAt: status.createdAt.toISOString(),
      expiresAt: status.expiresAt.toISOString(),
      needsReauth,
    })
  })
}
