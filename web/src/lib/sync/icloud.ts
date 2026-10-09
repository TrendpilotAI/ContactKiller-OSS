import type { RecordId } from 'surrealdb'
import vCard from 'vcf'
import type { Db } from '@/lib/db/client'
import { reconcileProviderContacts, type ProviderContact, type ReconcileResult } from './reconcile'

export interface VcfImportOutcome extends ReconcileResult {
  total: number
}

export class EmptyVcfError extends Error {
  constructor() {
    super('No contacts found in file')
    this.name = 'EmptyVcfError'
  }
}

const MAX_UID_LENGTH = 512

// Imports vCards for one user under the same rules as the Google sync (see
// reconcileProviderContacts): exact identifiers only, never names; matches fill
// empty fields and file conflicts instead of overwriting; ambiguous cards are
// skipped or imported on their own and reported. A card's UID is its stable
// identity, so re-importing the same file updates contacts in place; a card
// without a UID gets a throwaway id and is recognised only by email or phone.
export async function importVcf(db: Db, userId: RecordId, vcfContent: string): Promise<VcfImportOutcome> {
  // The vcf parser only understands CRLF line endings; many exports use LF.
  const normalized = vcfContent.replace(/\r\n|\r|\n/g, '\r\n')
  if (normalized.trim() === '') {
    throw new EmptyVcfError()
  }
  const cards = vCard.parse(normalized)
  if (!cards || cards.length === 0) {
    throw new EmptyVcfError()
  }

  const contacts: ProviderContact[] = []
  const extractionErrors: string[] = []
  for (const card of cards) {
    try {
      contacts.push(toProviderContact(card.data || card))
    } catch (err) {
      extractionErrors.push(`Error processing contact: ${err}`)
    }
  }

  const result = await reconcileProviderContacts(db, userId, 'icloud', contacts)
  return { ...result, errors: [...extractionErrors, ...result.errors], total: cards.length }
}

function toProviderContact(data: Record<string, unknown>): ProviderContact {
  const fn = getString(data.fn)
  const n = getString(data.n)
  let firstName: string | null = null
  let lastName: string | null = null

  if (n) {
    const nameParts = n.split(';')
    lastName = nameParts[0] || null
    firstName = nameParts[1] || null
  }

  const displayName = fn || [firstName, lastName].filter(Boolean).join(' ') || null

  const emails = extractArray(data.email).map(e => ({
    email: cleanValue(e),
    label: getType(e) || 'personal',
  })).filter(e => e.email && e.email.includes('@'))

  // The raw value is stored and matched as written (minus a leading tel: and
  // vCard escapes); normalizePhone alone decides whether it is a number.
  const phones = extractArray(data.tel).map(p => ({
    phone: rawPhoneValue(p),
    label: getType(p) || 'mobile',
  })).filter(p => p.phone)

  const uid = getString(data.uid)?.trim()
  const hasUid = !!uid && uid.length <= MAX_UID_LENGTH

  return {
    providerId: hasUid ? uid : `icloud-import-${crypto.randomUUID()}`,
    stableId: hasUid,
    fields: {
      first_name: firstName,
      last_name: lastName,
      display_name: displayName,
      company: getString(data.org)?.split(';')[0] || null,
      job_title: getString(data.title),
    },
    emails,
    phones,
  }
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

// vCard TEXT escapes: \, \; \\ and \n.
function unescapeVcard(value: string): string {
  return value.replace(/\\([,;\\nN])/g, (_, char: string) => (char === 'n' || char === 'N' ? '\n' : char))
}

function rawPhoneValue(value: unknown): string {
  const str = getString(value)
  if (!str) return ''
  return unescapeVcard(str.trim().replace(/^tel:/i, '')).trim()
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
