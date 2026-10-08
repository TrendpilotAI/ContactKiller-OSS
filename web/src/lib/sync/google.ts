import { google, people_v1 } from 'googleapis'
import type { RecordId } from 'surrealdb'
import type { Db } from '@/lib/db/client'
import { createContact, loadIdentityIndex, updateImportedContact } from '@/lib/db/contacts'
import { isLikelyFinancialAdvisor } from '@/lib/fa-detection'
import { parsePhoneNumber } from 'libphonenumber-js'

// Fields to fetch from Google People API
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,metadata'
const PAGE_SIZE = 1000

export interface SyncResult {
  imported: number
  updated: number
  conflicts: number
  errors: string[]
}

// Fetch all contacts from Google using pagination
export async function fetchGoogleContacts(
  accessToken: string
): Promise<people_v1.Schema$Person[]> {
  const auth = new google.auth.OAuth2()
  auth.setCredentials({ access_token: accessToken })
  const people = google.people({ version: 'v1', auth })

  const allContacts: people_v1.Schema$Person[] = []
  let pageToken: string | undefined

  do {
    const response = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: PAGE_SIZE,
      pageToken,
      personFields: PERSON_FIELDS,
    })

    if (response.data.connections) {
      allContacts.push(...response.data.connections)
    }

    pageToken = response.data.nextPageToken || undefined
  } while (pageToken)

  return allContacts
}

// Normalize phone number for consistent matching
export function normalizePhone(phone: string): string | null {
  try {
    // Try to parse as US number first, then international
    const parsed = parsePhoneNumber(phone, 'US')
    if (parsed) {
      return parsed.format('E.164') // e.g., +12025550123
    }
  } catch {
    // Fall back to simple normalization
    const digits = phone.replace(/\D/g, '')
    if (digits.length >= 10) {
      return digits.slice(-10)
    }
  }
  return null
}

// Sync Google contacts into SurrealDB for one user
export async function syncGoogleContacts(
  db: Db,
  userId: RecordId,
  accessToken: string
): Promise<SyncResult> {
  return reconcileGoogleContacts(db, userId, await fetchGoogleContacts(accessToken))
}

export async function reconcileGoogleContacts(
  db: Db,
  userId: RecordId,
  googleContacts: people_v1.Schema$Person[]
): Promise<SyncResult> {
  const result: SyncResult = {
    imported: 0,
    updated: 0,
    conflicts: 0,
    errors: [],
  }

  // Build lookup maps for matching against everything this user already has
  const index = await loadIdentityIndex(db)
  const emailToContactId = index.emails
  const googleIdToContactId = index.googleIds
  const phoneToContactId = new Map<string, string>()
  for (const p of index.phones) {
    const normalized = normalizePhone(p.phone)
    if (normalized) {
      phoneToContactId.set(normalized, p.contact)
    }
  }

  // Process each Google contact
  for (const gc of googleContacts) {
    try {
      const googleId = gc.resourceName
      if (!googleId) continue

      // Extract contact data
      const name = gc.names?.[0]
      const firstName = name?.givenName || null
      const lastName = name?.familyName || null
      const displayName = name?.displayName || `${firstName || ''} ${lastName || ''}`.trim() || 'Unknown'

      const emails = (gc.emailAddresses || []).map(e => ({
        email: e.value!,
        label: e.type || 'other',
      })).filter(e => e.email)

      const phones = (gc.phoneNumbers || []).map(p => ({
        phone: p.value!,
        label: p.type || 'other',
      })).filter(p => p.phone)

      const company = gc.organizations?.[0]?.name || null
      const jobTitle = gc.organizations?.[0]?.title || null

      // Check if FA based on email domains
      const isFA = isLikelyFinancialAdvisor(emails.map(e => e.email))

      // Try to find existing contact
      let existingContactId: string | null = null

      // 1. Check by Google ID (most reliable)
      existingContactId = googleIdToContactId.get(googleId) || null

      // 2. Check by email
      if (!existingContactId) {
        for (const e of emails) {
          const id = emailToContactId.get(e.email.toLowerCase())
          if (id) {
            existingContactId = id
            break
          }
        }
      }

      // 3. Check by phone
      if (!existingContactId) {
        for (const p of phones) {
          const normalized = normalizePhone(p.phone)
          if (normalized) {
            const id = phoneToContactId.get(normalized)
            if (id) {
              existingContactId = id
              break
            }
          }
        }
      }

      const fields = {
        first_name: firstName,
        last_name: lastName,
        display_name: displayName,
        company,
        job_title: jobTitle,
        is_financial_advisor: isFA,
      }
      const link = { platform: 'google' as const, platform_id: googleId }

      if (existingContactId) {
        await updateImportedContact(db, userId, existingContactId, fields, link)
        googleIdToContactId.set(googleId, existingContactId)
        result.updated++
      } else {
        const newContactId = await createContact(db, userId, {
          fields,
          emails: emails.map((e, i) => ({ value: e.email, label: e.label, is_primary: i === 0 })),
          phones: phones.map((p, i) => ({ value: p.phone, label: p.label, is_primary: i === 0 })),
          links: [link],
        })

        // Update lookup maps for subsequent matching
        for (const e of emails) {
          emailToContactId.set(e.email.toLowerCase(), newContactId)
        }
        for (const p of phones) {
          const normalized = normalizePhone(p.phone)
          if (normalized) {
            phoneToContactId.set(normalized, newContactId)
          }
        }
        googleIdToContactId.set(googleId, newContactId)

        result.imported++
      }
    } catch (err) {
      result.errors.push(`Error processing contact: ${err}`)
    }
  }

  return result
}
