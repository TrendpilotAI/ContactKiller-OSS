import { NextRequest, NextResponse } from 'next/server'
import { withSession } from '@/lib/db/session'
import { finishSyncLog, startSyncLog } from '@/lib/db/sync-logs'
import { EmptyVcfError, importVcf } from '@/lib/sync/icloud'

// POST /api/import/icloud - Import contacts from vCard file
export async function POST(request: NextRequest): Promise<Response> {
  // Get form data with file
  const formData = await request.formData()
  const file = formData.get('vcf') as File | null

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  // Validate file type
  if (!file.name.endsWith('.vcf') && !file.name.endsWith('.vcard')) {
    return NextResponse.json({ error: 'Invalid file type. Please upload a .vcf file.' }, { status: 400 })
  }

  const vcfContent = await file.text()

  return withSession(async ({ db, userId }) => {
    const syncLogId = await startSyncLog(db, userId, 'icloud', 'import')
    try {
      const outcome = await importVcf(db, userId, vcfContent)

      await finishSyncLog(db, syncLogId, {
        status: 'completed',
        contactsProcessed: outcome.imported,
      })

      return NextResponse.json({
        success: true,
        imported: outcome.imported,
        duplicates: outcome.duplicates,
        total: outcome.total,
        errors: outcome.errors.length > 0 ? outcome.errors.slice(0, 10) : undefined,
      })
    } catch (err) {
      await finishSyncLog(db, syncLogId, {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      }).catch((logError) => console.error('Failed to record import failure:', logError))

      if (err instanceof EmptyVcfError) {
        return NextResponse.json({ error: 'No contacts found in file' }, { status: 400 })
      }
      console.error('iCloud import failed:', err)
      return NextResponse.json(
        { error: 'Import failed. Please check your file format.' },
        { status: 500 }
      )
    }
  })
}
