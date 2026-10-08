import type { RecordId } from 'surrealdb'
import vCard from 'vcf'
import type { Db } from '@/lib/db/client'
import { createContact, loadIdentityIndex } from '@/lib/db/contacts'
import { isLikelyFinancialAdvisor } from '@/lib/fa-detection'

export interface ImportResult {
  imported: number
  duplicates: number
  errors: string[]
}

export interface VcfImportOutcome extends ImportResult {
  total: number
}

export class EmptyVcfError extends Error {
  constructor() {
    super('No contacts found in file')
    this.name = 'EmptyVcfError'
  }
}

// Imports vCards for one user. A card is skipped as a duplicate when any of its
// email addresses already belongs to one of the user's contacts.
export async function importVcf(db: Db, userId: RecordId, vcfContent: string): Promise<VcfImportOutcome> {
  const result: ImportResult = {
    imported: 0,
    duplicates: 0,
    errors: [],
  }

  // The vcf parser only understands CRLF line endings; many exports use LF.
  const normalized = vcfContent.replace(/\r\n|\r|\n/g, '\r\n')
  if (normalized.trim() === '') {
    throw new EmptyVcfError()
  }
  const cards = vCard.parse(normalized)
  if (!cards || cards.length === 0) {
    throw new EmptyVcfError()
  }

  const knownEmails = (await loadIdentityIndex(db)).emails

  for (const card of cards) {
    try {
      const data = card.data || card

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

      const emails = extractArray(data.email).map(e => ({
        email: cleanValue(e),
        label: getType(e) || 'personal',
      })).filter(e => e.email && e.email.includes('@'))

      const phones = extractArray(data.tel).map(p => ({
        phone: cleanPhoneValue(p),
        label: getType(p) || 'mobile',
      })).filter(p => p.phone && p.phone.length >= 7)

      const org = getString(data.org)?.split(';')[0] || null
      const title = getString(data.title)

      if (emails.some(e => knownEmails.has(e.email.toLowerCase()))) {
        result.duplicates++
        continue
      }

      const contactId = await createContact(db, userId, {
        fields: {
          first_name: firstName,
          last_name: lastName,
          display_name: displayName,
          company: org,
          job_title: title,
          is_financial_advisor: isLikelyFinancialAdvisor(emails.map(e => e.email)),
        },
        emails: emails.map((e, i) => ({ value: e.email, label: e.label, is_primary: i === 0 })),
        phones: phones.map((p, i) => ({ value: p.phone, label: p.label, is_primary: i === 0 })),
        links: [{ platform: 'icloud', platform_id: `icloud-import-${Date.now()}-${result.imported}` }],
      })

      for (const e of emails) {
        knownEmails.set(e.email.toLowerCase(), new Set([contactId]))
      }

      result.imported++
    } catch (err) {
      result.errors.push(`Error processing contact: ${err}`)
    }
  }

  return { ...result, total: cards.length }
}

// Helper functions for vCard parsing

// A vcf Property's toString() renders the whole line ("N:Park;Lena"), so read
// its valueOf() instead. Structured values (N, ORG) arrive as component arrays.
function getString(value: unknown): string | null {
  if (!value) return null
  const raw = typeof value === 'object' ? (value as { valueOf(): unknown }).valueOf() : value
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw.join(';')
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
