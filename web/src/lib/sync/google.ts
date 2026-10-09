import { google, people_v1 } from 'googleapis'
import type { RecordId } from 'surrealdb'
import type { Db } from '@/lib/db/client'
import {
  createContact,
  fileConflictsOnce,
  isUniqueViolation,
  loadIdentityIndex,
  mergeImportedContact,
  type ConflictEntry,
  type ImportedFields,
} from '@/lib/db/contacts'
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
  // Google contacts deliberately not linked or merged, with the reason.
  skipped: string[]
  // Contacts imported on their own because their email is on several Google
  // contacts; each has a `shared_email` conflict to review.
  sharedEmailContacts: number
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

// Exact phone identity: the number must parse as a valid number. There is no
// "last 10 digits" fallback, so numbers that differ in area code, country
// code, or leading digits never compare equal.
export function normalizePhone(phone: string): string | null {
  try {
    const parsed = parsePhoneNumber(phone, 'US')
    return parsed.isValid() ? parsed.format('E.164') : null
  } catch {
    return null
  }
}

// Sync Google contacts into SurrealDB for one user
export async function syncGoogleContacts(
  db: Db,
  userId: RecordId,
  accessToken: string
): Promise<SyncResult> {
  return reconcileGoogleContacts(db, userId, await fetchGoogleContacts(accessToken))
}

interface Candidate {
  googleId: string
  fields: ImportedFields
  emails: { email: string; label: string }[]
  phones: { phone: string; label: string }[]
  emailKeys: string[]
  phoneKeys: string[]
  // Filled in once the whole batch is known.
  sharedEmails: string[]
}

type Decision =
  | { kind: 'create' }
  | { kind: 'update'; target: string; linkedById: boolean }
  | { kind: 'skip'; reason: string }

function toCandidate(gc: people_v1.Schema$Person): Candidate | null {
  const googleId = gc.resourceName
  if (!googleId) return null

  const name = gc.names?.[0]
  const firstName = name?.givenName || null
  const lastName = name?.familyName || null
  const displayName = name?.displayName || `${firstName || ''} ${lastName || ''}`.trim() || null

  const emails = (gc.emailAddresses || []).map(e => ({
    email: e.value!,
    label: e.type || 'other',
  })).filter(e => e.email)

  const phones = (gc.phoneNumbers || []).map(p => ({
    phone: p.value!,
    label: p.type || 'other',
  })).filter(p => p.phone)

  return {
    googleId,
    fields: {
      first_name: firstName,
      last_name: lastName,
      display_name: displayName,
      company: gc.organizations?.[0]?.name || null,
      job_title: gc.organizations?.[0]?.title || null,
    },
    emails,
    phones,
    emailKeys: [...new Set(emails.map(e => e.email.trim().toLowerCase()))],
    phoneKeys: [...new Set(phones.map(p => normalizePhone(p.phone)).filter((p): p is string => p !== null))],
    sharedEmails: [],
  }
}

function owners(keysByCandidate: Candidate[], pick: (c: Candidate) => string[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const candidate of keysByCandidate) {
    for (const key of pick(candidate)) {
      const set = map.get(key) ?? new Set<string>()
      set.add(candidate.googleId)
      map.set(key, set)
    }
  }
  return map
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
    skipped: [],
    sharedEmailContacts: 0,
  }

  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const gc of googleContacts) {
    const candidate = toCandidate(gc)
    if (candidate && !seen.has(candidate.googleId)) {
      seen.add(candidate.googleId)
      candidates.push(candidate)
    }
  }

  const index = await loadIdentityIndex(db)
  const localPhones = new Map<string, Set<string>>()
  for (const p of index.phones) {
    const normalized = normalizePhone(p.phone)
    if (normalized) {
      const set = localPhones.get(normalized) ?? new Set<string>()
      set.add(p.contact)
      localPhones.set(normalized, set)
    }
  }
  const emailOwners = owners(candidates, c => c.emailKeys)
  for (const candidate of candidates) {
    candidate.sharedEmails = candidate.emailKeys.filter(email => (emailOwners.get(email)?.size ?? 0) > 1)
  }
  const phoneOwners = owners(candidates, c => c.phoneKeys)

  // Pass 1: decide, using only exact identifiers and only against what existed
  // before this batch. Nothing here writes.
  const decisions = new Map<string, Decision>()
  for (const candidate of candidates) {
    const linked = index.googleIds.get(candidate.googleId)
    if (linked) {
      decisions.set(candidate.googleId, { kind: 'update', target: linked, linkedById: true })
      continue
    }

    const targets = new Set<string>()
    // An address held by several Google contacts is not evidence that any of
    // them is the local contact that has it, so it is never a match key.
    for (const email of candidate.emailKeys) {
      if (candidate.sharedEmails.includes(email)) continue
      for (const contact of index.emails.get(email) ?? []) targets.add(contact)
    }
    // A phone shared by several Google contacts (a family landline) is not
    // identity evidence for any of them.
    for (const phone of candidate.phoneKeys) {
      if ((phoneOwners.get(phone)?.size ?? 0) > 1) continue
      for (const contact of localPhones.get(phone) ?? []) targets.add(contact)
    }

    if (targets.size > 1) {
      decisions.set(candidate.googleId, {
        kind: 'skip',
        reason: 'its identifiers match more than one existing contact',
      })
    } else if (targets.size === 1) {
      const [target] = targets
      const existingLink = index.googleLinkByContact.get(target)
      decisions.set(
        candidate.googleId,
        existingLink
          ? {
              kind: 'skip',
              reason: 'the matching contact is already linked to a different Google contact',
            }
          : { kind: 'update', target, linkedById: false }
      )
    } else {
      decisions.set(candidate.googleId, { kind: 'create' })
    }
  }

  // Pass 2: two Google contacts claiming the same unlinked local contact are
  // both ambiguous; neither may take it.
  const claims = new Map<string, string[]>()
  for (const [googleId, decision] of decisions) {
    if (decision.kind === 'update' && !decision.linkedById) {
      claims.set(decision.target, [...(claims.get(decision.target) ?? []), googleId])
    }
  }
  for (const claimants of claims.values()) {
    if (claimants.length > 1) {
      for (const googleId of claimants) {
        decisions.set(googleId, {
          kind: 'skip',
          reason: 'the matching contact was also matched by another Google contact',
        })
      }
    }
  }

  // Pass 3: write.
  const sharedEmailConflicts = (candidate: Candidate): ConflictEntry[] =>
    candidate.sharedEmails.map(email => ({
      field: 'shared_email',
      value_a: email,
      value_b: 'Also on other Google contacts',
      source_a: 'google',
      source_b: 'google',
    }))

  const updateExisting = async (candidate: Candidate, target: string) => {
    const outcome = await mergeImportedContact(
      db,
      userId,
      target,
      candidate.fields,
      { platform: 'google', platform_id: candidate.googleId },
      { local: 'local', provider: 'google' }
    )
    result.conflicts += outcome.conflicts.length
    result.conflicts += await fileConflictsOnce(db, userId, target, sharedEmailConflicts(candidate))
    result.updated++
  }

  for (const candidate of candidates) {
    const decision = decisions.get(candidate.googleId)!
    try {
      if (decision.kind === 'skip') {
        const message = `${candidate.googleId}: not linked, ${decision.reason}`
        console.warn(`Google sync skipped ${message}`)
        result.skipped.push(message)
      } else if (decision.kind === 'update') {
        await updateExisting(candidate, decision.target)
      } else {
        try {
          const created = await createContact(db, userId, {
            fields: {
              ...candidate.fields,
              display_name: candidate.fields.display_name || 'Unknown',
              is_financial_advisor: isLikelyFinancialAdvisor(candidate.emails.map(e => e.email)),
            },
            emails: candidate.emails.map((e, i) => ({ value: e.email, label: e.label, is_primary: i === 0 })),
            phones: candidate.phones.map((p, i) => ({ value: p.phone, label: p.label, is_primary: i === 0 })),
            links: [{ platform: 'google', platform_id: candidate.googleId }],
          })
          const filed = await fileConflictsOnce(db, userId, created, sharedEmailConflicts(candidate))
          result.conflicts += filed
          if (candidate.sharedEmails.length > 0) result.sharedEmailContacts++
          result.imported++
        } catch (err) {
          // A concurrent sync created this Google contact first: the unique
          // link index refused ours and rolled it back. Treat it as already
          // linked and carry on with the contact that won.
          if (!isUniqueViolation(err)) throw err
          const winner = (await loadIdentityIndex(db)).googleIds.get(candidate.googleId)
          if (!winner) throw err
          await updateExisting(candidate, winner)
        }
      }
    } catch (err) {
      result.errors.push(`Error processing contact: ${err}`)
    }
  }

  return result
}
