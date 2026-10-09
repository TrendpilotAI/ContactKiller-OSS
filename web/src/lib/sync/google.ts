import { google, people_v1 } from 'googleapis'
import type { RecordId } from 'surrealdb'
import type { Db } from '@/lib/db/client'
import { reconcileProviderContacts, type ProviderContact, type ReconcileResult } from './reconcile'

export { normalizePhone } from './phone'

// Fields to fetch from Google People API
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,metadata'
const PAGE_SIZE = 1000

export type SyncResult = ReconcileResult

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

// Sync Google contacts into SurrealDB for one user
export async function syncGoogleContacts(
  db: Db,
  userId: RecordId,
  accessToken: string
): Promise<SyncResult> {
  return reconcileGoogleContacts(db, userId, await fetchGoogleContacts(accessToken))
}

function toProviderContact(gc: people_v1.Schema$Person): ProviderContact | null {
  const providerId = gc.resourceName
  if (!providerId) return null

  const name = gc.names?.[0]
  const firstName = name?.givenName || null
  const lastName = name?.familyName || null
  const displayName = name?.displayName || `${firstName || ''} ${lastName || ''}`.trim() || null

  return {
    providerId,
    stableId: true,
    fields: {
      first_name: firstName,
      last_name: lastName,
      display_name: displayName,
      company: gc.organizations?.[0]?.name || null,
      job_title: gc.organizations?.[0]?.title || null,
    },
    emails: (gc.emailAddresses || [])
      .map(e => ({ email: e.value!, label: e.type || 'other' }))
      .filter(e => e.email),
    phones: (gc.phoneNumbers || [])
      .map(p => ({ phone: p.value!, label: p.type || 'other', canonicalForm: p.canonicalForm }))
      .filter(p => p.phone),
  }
}

export async function reconcileGoogleContacts(
  db: Db,
  userId: RecordId,
  googleContacts: people_v1.Schema$Person[]
): Promise<SyncResult> {
  const contacts = googleContacts
    .map(toProviderContact)
    .filter((contact): contact is ProviderContact => contact !== null)
  return reconcileProviderContacts(db, userId, 'google', contacts)
}
