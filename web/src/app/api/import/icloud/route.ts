import { NextRequest, NextResponse } from 'next/server'
import { withSession } from '@/lib/db/session'
import { MAX_UPLOAD_BYTES, guardRequest, readLimitedFormData } from '@/lib/request-guard'
import { finishSyncLog, startSyncLog } from '@/lib/db/sync-logs'
import { EmptyVcfError, importVcf } from '@/lib/sync/icloud'

// Form framing around the file itself.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024

// POST /api/import/icloud - Import contacts from vCard file
export async function POST(request: NextRequest): Promise<Response> {
  const blocked = guardRequest(request)
  if (blocked) return blocked

  // Authenticate before reading any of the body.
  return withSession(async ({ db, userId }) => {
    const formData = await readLimitedFormData(request, MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES)
    if (!formData) {
      return NextResponse.json(
        { error: `Upload must be a form under ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` },
        { status: 413 }
      )
    }

    const file = formData.get('vcf')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: 'File is too large.' }, { status: 413 })
    }

    // Validate file type
    if (!file.name.endsWith('.vcf') && !file.name.endsWith('.vcard')) {
      return NextResponse.json({ error: 'Invalid file type. Please upload a .vcf file.' }, { status: 400 })
    }

    const vcfContent = await file.text()
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
