import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isLikelyFinancialAdvisor } from '@/lib/fa-detection'
import vCard from 'vcf'

export interface ImportResult {
  imported: number
  duplicates: number
  errors: string[]
}

// POST /api/import/icloud - Import contacts from vCard file
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()

  // Check authentication
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

  const result: ImportResult = {
    imported: 0,
    duplicates: 0,
    errors: [],
  }

  try {
    // Read file content
    const vcfContent = await file.text()

    // Parse vCards
    const cards = vCard.parse(vcfContent)

    if (!cards || cards.length === 0) {
      return NextResponse.json({ error: 'No contacts found in file' }, { status: 400 })
    }

    // Get existing emails for duplicate detection
    const { data: existingEmails } = await supabase
      .from('emails')
      .select('email, contact_id')

    const emailToContactId = new Map<string, string>()
    for (const e of existingEmails || []) {
      emailToContactId.set(e.email.toLowerCase(), e.contact_id)
    }

    // Log import start
    const { data: syncLog } = await supabase
      .from('sync_logs')
      .insert({
        user_id: user.id,
        platform: 'icloud',
        operation: 'import',
        status: 'started',
      })
      .select('id')
      .single()

    // Process each vCard
    for (const card of cards) {
      try {
        // Extract data from vCard
        const data = card.data || card

        // Get name
        const fn = getString(data.fn)
        const n = getString(data.n)
        let firstName: string | null = null
        let lastName: string | null = null

        if (n) {
          const nameParts = n.split(';')
          lastName = nameParts[0] || null
          firstName = nameParts[1] || null
        }

        const displayName = fn || [firstName, lastName].filter(Boolean).join(' ') || 'Unknown'

        // Get emails
        const emails = extractArray(data.email).map(e => ({
          email: cleanValue(e),
          label: getType(e) || 'personal',
        })).filter(e => e.email && e.email.includes('@'))

        // Get phones
        const phones = extractArray(data.tel).map(p => ({
          phone: cleanPhoneValue(p),
          label: getType(p) || 'mobile',
        })).filter(p => p.phone && p.phone.length >= 7)

        // Get organization
        const org = getString(data.org)
        const title = getString(data.title)

        // Check for duplicates by email
        let isDuplicate = false
        for (const e of emails) {
          if (emailToContactId.has(e.email.toLowerCase())) {
            isDuplicate = true
            break
          }
        }

        if (isDuplicate) {
          result.duplicates++
          continue
        }

        // Check if FA
        const isFA = isLikelyFinancialAdvisor(emails.map(e => e.email))

        // Insert contact
        const { data: newContact, error: insertError } = await supabase
          .from('contacts')
          .insert({
            user_id: user.id,
            first_name: firstName,
            last_name: lastName,
            display_name: displayName,
            company: org,
            job_title: title,
            is_financial_advisor: isFA,
          })
          .select('id')
          .single()

        if (insertError || !newContact) {
          result.errors.push(`Failed to insert ${displayName}: ${insertError?.message}`)
          continue
        }

        // Insert emails
        if (emails.length > 0) {
          await supabase.from('emails').insert(
            emails.map((e, i) => ({
              contact_id: newContact.id,
              email: e.email,
              label: e.label,
              is_primary: i === 0,
            }))
          )
          // Update lookup map
          for (const e of emails) {
            emailToContactId.set(e.email.toLowerCase(), newContact.id)
          }
        }

        // Insert phones
        if (phones.length > 0) {
          await supabase.from('phones').insert(
            phones.map((p, i) => ({
              contact_id: newContact.id,
              phone: p.phone,
              label: p.label,
              is_primary: i === 0,
            }))
          )
        }

        // Add platform link
        await supabase.from('platform_links').insert({
          contact_id: newContact.id,
          platform: 'icloud',
          platform_id: `icloud-import-${Date.now()}-${result.imported}`,
          last_synced_at: new Date().toISOString(),
        })

        result.imported++

      } catch (err) {
        result.errors.push(`Error processing contact: ${err}`)
      }
    }

    // Log import completion
    if (syncLog) {
      await supabase
        .from('sync_logs')
        .update({
          status: 'completed',
          contacts_processed: result.imported,
          completed_at: new Date().toISOString(),
        })
        .eq('id', syncLog.id)
    }

    return NextResponse.json({
      success: true,
      imported: result.imported,
      duplicates: result.duplicates,
      total: cards.length,
      errors: result.errors.length > 0 ? result.errors.slice(0, 10) : undefined,
    })

  } catch (err) {
    console.error('iCloud import failed:', err)
    return NextResponse.json(
      { error: 'Import failed. Please check your file format.' },
      { status: 500 }
    )
  }
}

// Helper functions for vCard parsing

function getString(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    // vcf library wraps strings as String objects
    return String(value)
  }
  return null
}

function extractArray(value: unknown): unknown[] {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

function cleanValue(value: unknown): string {
  const str = getString(value)
  if (!str) return ''
  // Remove tel: prefix if present
  return str.replace(/^(tel:|mailto:)/i, '').trim()
}

function cleanPhoneValue(value: unknown): string {
  const str = cleanValue(value)
  // Keep only digits, spaces, dashes, parentheses, and plus sign
  return str.replace(/[^\d\s\-()+ ]/g, '').trim()
}

function getType(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (obj.type) {
    if (Array.isArray(obj.type)) {
      return obj.type[0] as string
    }
    return obj.type as string
  }
  return null
}
