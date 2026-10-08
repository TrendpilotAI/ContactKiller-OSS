import { NextRequest, NextResponse } from 'next/server'
import { MAX_BULK_IDS, bulkSetFinancialAdvisor } from '@/lib/db/contacts'
import { isRecordKey } from '@/lib/db/client'
import { withSession } from '@/lib/db/session'

// POST /api/contacts/bulk-tag - Tag multiple contacts
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const ids: unknown = body?.ids
  const isFinancialAdvisor: unknown = body?.is_financial_advisor

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids array is required' }, { status: 400 })
  }
  if (ids.length > MAX_BULK_IDS || !ids.every(isRecordKey)) {
    return NextResponse.json(
      { error: `ids must be at most ${MAX_BULK_IDS} contact ids` },
      { status: 400 }
    )
  }
  if (typeof isFinancialAdvisor !== 'boolean') {
    return NextResponse.json({ error: 'is_financial_advisor must be a boolean' }, { status: 400 })
  }

  return withSession(async ({ db }) => {
    const updated = await bulkSetFinancialAdvisor(db, ids, isFinancialAdvisor)
    return NextResponse.json({ updated: updated.length, ids: updated })
  })
}
