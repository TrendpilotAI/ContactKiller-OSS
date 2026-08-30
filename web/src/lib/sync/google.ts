import { google, people_v1 } from 'googleapis'
import { SupabaseClient } from '@supabase/supabase-js'
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
function normalizePhone(phone: string): string | null {
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

// Sync Google contacts to local database
export async function syncGoogleContacts(
  supabase: SupabaseClient,
  userId: string,
  accessToken: string
): Promise<SyncResult> {
  const result: SyncResult = {
    imported: 0,
    updated: 0,
    conflicts: 0,
    errors: [],
  }

  // Fetch all Google contacts
  const googleContacts = await fetchGoogleContacts(accessToken)

  // Get all existing contacts with emails for this user
  const { data: existingContacts } = await supabase
    .from('contacts')
    .select(`
      id,
      display_name,
      first_name,
      last_name,
      emails (email),
      phones (phone),
      platform_links!inner (platform, platform_id)
    `)
    .eq('user_id', userId)

  // Build lookup maps for matching
  const emailToContactId = new Map<string, string>()
  const phoneToContactId = new Map<string, string>()
  const googleIdToContactId = new Map<string, string>()

  for (const contact of existingContacts || []) {
    // Map emails
    for (const e of contact.emails || []) {
      emailToContactId.set(e.email.toLowerCase(), contact.id)
    }
    // Map phones
    for (const p of contact.phones || []) {
      const normalized = normalizePhone(p.phone)
      if (normalized) {
        phoneToContactId.set(normalized, contact.id)
      }
    }
    // Map Google IDs
    for (const link of contact.platform_links || []) {
      if (link.platform === 'google') {
        googleIdToContactId.set(link.platform_id, contact.id)
      }
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

      if (existingContactId) {
        // Update existing contact
        await supabase
          .from('contacts')
          .update({
            first_name: firstName,
            last_name: lastName,
            display_name: displayName,
            company,
            job_title: jobTitle,
            is_financial_advisor: isFA,
          })
          .eq('id', existingContactId)

        // Ensure platform link exists
        await supabase
          .from('platform_links')
          .upsert({
            contact_id: existingContactId,
            platform: 'google',
            platform_id: googleId,
            last_synced_at: new Date().toISOString(),
          }, {
            onConflict: 'contact_id,platform',
            ignoreDuplicates: false,
          })

        result.updated++
      } else {
        // Create new contact
        const { data: newContact, error: insertError } = await supabase
          .from('contacts')
          .insert({
            user_id: userId,
            first_name: firstName,
            last_name: lastName,
            display_name: displayName,
            company,
            job_title: jobTitle,
            is_financial_advisor: isFA,
          })
          .select('id')
          .single()

        if (insertError || !newContact) {
          result.errors.push(`Failed to insert contact ${displayName}: ${insertError?.message}`)
          continue
        }

        // Add emails
        if (emails.length > 0) {
          await supabase.from('emails').insert(
            emails.map((e, i) => ({
              contact_id: newContact.id,
              email: e.email,
              label: e.label,
              is_primary: i === 0,
            }))
          )
        }

        // Add phones
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
          platform: 'google',
          platform_id: googleId,
          last_synced_at: new Date().toISOString(),
        })

        // Update lookup maps for subsequent matching
        for (const e of emails) {
          emailToContactId.set(e.email.toLowerCase(), newContact.id)
        }
        for (const p of phones) {
          const normalized = normalizePhone(p.phone)
          if (normalized) {
            phoneToContactId.set(normalized, newContact.id)
          }
        }
        googleIdToContactId.set(googleId, newContact.id)

        result.imported++
      }
    } catch (err) {
      result.errors.push(`Error processing contact: ${err}`)
    }
  }

  return result
}
