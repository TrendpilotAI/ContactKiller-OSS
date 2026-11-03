import type { RecordId } from 'surrealdb'
import type { Db } from '@/lib/db/client'
import {
  LinkConflictError,
  createContact,
  fileConflictsOnce,
  findContactByLink,
  isUniqueViolation,
  loadIdentityIndex,
  mergeImportedContact,
  type ConflictEntry,
  type ImportedFields,
} from '@/lib/db/contacts'
import type { Platform } from '@/lib/db/types'
import { isLikelyFinancialAdvisor } from '@/lib/fa-detection'
import { phoneKey } from './phone'

export interface ProviderContact {
  // The provider's identifier for this contact: Google's resourceName, or a
  // vCard UID.
  providerId: string
  // False when the identifier is a random throwaway invented for this run (a
  // card without a UID). It is used only to tell cards in one batch apart and is
  // never stored as a platform link: it could not recognise the contact next
  // time, and an invented link would stand in the way of linking the real id
  // later.
  stableId: boolean
  fields: ImportedFields
  emails: { email: string; label: string }[]
  // `phone` is the value as the provider gave it (stored as-is). `canonicalForm`
  // is the provider's own E.164, when it supplies one.
  phones: { phone: string; label: string; canonicalForm?: string | null }[]
}

export interface ReconcileResult {
  imported: number
  updated: number
  // Fields filled on matched contacts.
  filledFields: number
  conflicts: number
  errors: string[]
  // Provider contacts deliberately not linked or merged, with the reason.
  skipped: string[]
  // Contacts imported on their own because their email is on several provider
  // contacts; each has a `shared_email` conflict to review.
  sharedEmailContacts: number
}

const PLATFORM_LABEL: Record<Platform, string> = {
  google: 'Google',
  icloud: 'iCloud',
  whatsapp: 'WhatsApp',
  contacts_plus: 'Contacts+',
}

interface Candidate extends ProviderContact {
  emailKeys: string[]
  phoneKeys: string[]
  sharedEmails: string[]
}

type Decision =
  | { kind: 'create' }
  | { kind: 'update'; target: string; linkedById: boolean; hasLink: boolean }
  | { kind: 'skip'; reason: string }

function owners(candidates: Candidate[], pick: (c: Candidate) => string[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    for (const key of pick(candidate)) {
      const set = map.get(key) ?? new Set<string>()
      set.add(candidate.providerId)
      map.set(key, set)
    }
  }
  return map
}

// Imports one provider's contacts for one user using exact identifiers only
// (provider id, case-insensitive email, valid E.164 phone). Never names.
//
//   - A match fills empty local fields and files conflicts for differences. It
//     never overwrites, never touches is_financial_advisor, and never replaces
//     the platform_id of an existing link.
//   - An email (or phone) held by several provider contacts is not evidence for
//     any of them: it is never a match key. Contacts sharing an email are each
//     imported on their own, flagged with a `shared_email` conflict.
//   - Anything else ambiguous is skipped and reported, not guessed at.
export async function reconcileProviderContacts(
  db: Db,
  userId: RecordId,
  platform: Platform,
  contacts: ProviderContact[]
): Promise<ReconcileResult> {
  const label = PLATFORM_LABEL[platform]
  const result: ReconcileResult = {
    imported: 0,
    updated: 0,
    filledFields: 0,
    conflicts: 0,
    errors: [],
    skipped: [],
    sharedEmailContacts: 0,
  }

  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const contact of contacts) {
    if (seen.has(contact.providerId)) {
      result.skipped.push(`${contact.providerId}: not imported, the same id appears more than once in this batch`)
      continue
    }
    seen.add(contact.providerId)
    candidates.push({
      ...contact,
      emailKeys: [...new Set(contact.emails.map(e => e.email.trim().toLowerCase()))],
      phoneKeys: [...new Set(contact.phones.map(p => phoneKey(p.phone, p.canonicalForm)).filter((p): p is string => p !== null))],
      sharedEmails: [],
    })
  }

  const index = await loadIdentityIndex(db, platform)
  const localPhones = new Map<string, Set<string>>()
  const localRawPhones = new Set<string>()
  for (const p of index.phones) {
    localRawPhones.add(p.phone.trim())
    // Stored keys only: what a number meant when it was saved is what it means.
    if (p.key) {
      const set = localPhones.get(p.key) ?? new Set<string>()
      set.add(p.contact)
      localPhones.set(p.key, set)
    }
  }
  const emailOwners = owners(candidates, c => c.emailKeys)
  const phoneOwners = owners(candidates, c => c.phoneKeys)
  for (const candidate of candidates) {
    candidate.sharedEmails = candidate.emailKeys.filter(email => (emailOwners.get(email)?.size ?? 0) > 1)
  }

  // A card is recognisable by an exact key only if it has an email or phone
  // that is not shared with another card in this batch.
  const hasUsableKey = (candidate: Candidate): boolean =>
    candidate.emailKeys.some(email => !candidate.sharedEmails.includes(email)) ||
    candidate.phoneKeys.some(phone => (phoneOwners.get(phone)?.size ?? 0) <= 1)

  // Whether any local contact already carries one of the card's exact values
  // (emails, valid phone keys, or the raw phone text of an unkeyable number).
  const carriesLocally = (candidate: Candidate): boolean =>
    candidate.emailKeys.some(email => index.emails.has(email)) ||
    candidate.phoneKeys.some(phone => localPhones.has(phone)) ||
    candidate.phones.some(p => localRawPhones.has(p.phone.trim()))

  // Pass 1: decide, using only exact identifiers and only against what existed
  // before this batch. Nothing here writes.
  const decisions = new Map<string, Decision>()
  for (const candidate of candidates) {
    const linked = candidate.stableId ? index.linkIds.get(candidate.providerId) : undefined

    const targets = new Set<string>()
    // An address held by several provider contacts is not evidence that any of
    // them is the local contact that has it, so it is never a match key.
    for (const email of candidate.emailKeys) {
      if (candidate.sharedEmails.includes(email)) continue
      for (const contact of index.emails.get(email) ?? []) targets.add(contact)
    }
    // Likewise a phone shared by several (a family landline).
    for (const phone of candidate.phoneKeys) {
      if ((phoneOwners.get(phone)?.size ?? 0) > 1) continue
      for (const contact of localPhones.get(phone) ?? []) targets.add(contact)
    }

    if (linked) {
      // The id is the strongest evidence, but a card whose exact email or phone
      // belongs to a different contact is contradicting itself: do not merge.
      if ([...targets].some(target => target !== linked)) {
        decisions.set(candidate.providerId, {
          kind: 'skip',
          reason: `its ${label} id is linked to one contact but its email or phone match a different contact`,
        })
      } else {
        decisions.set(candidate.providerId, { kind: 'update', target: linked, linkedById: true, hasLink: true })
      }
    } else if (targets.size > 1) {
      decisions.set(candidate.providerId, {
        kind: 'skip',
        reason: 'its identifiers match more than one existing contact',
      })
    } else if (targets.size === 1) {
      const [target] = targets
      const existingLink = index.linkByContact.get(target)
      if (existingLink) {
        // Linked to a different id (the same id would have matched above). A
        // card without an id of its own cannot claim a linked contact either.
        decisions.set(candidate.providerId, {
          kind: 'skip',
          reason: `the matching contact is already linked to a different ${label} contact`,
        })
      } else {
        decisions.set(candidate.providerId, {
          kind: 'update',
          target,
          linkedById: false,
          hasLink: existingLink !== undefined,
        })
      }
    } else if (!candidate.stableId && !hasUsableKey(candidate) && carriesLocally(candidate)) {
      // No id and nothing unique to recognise it by, yet its exact values are
      // already on a local contact: this is most likely a card from an earlier
      // import. Creating it again would multiply duplicates on every sync.
      decisions.set(candidate.providerId, {
        kind: 'skip',
        reason: "it can't be told apart from an earlier import; not re-imported",
      })
    } else {
      decisions.set(candidate.providerId, { kind: 'create' })
    }
  }

  // Pass 2: a local contact may be taken by one provider contact only. When
  // several claim it, a card that reached it through its own link keeps it and
  // every card that merely matched an email or phone is ambiguous and skipped;
  // with no link-holder, all of them are skipped.
  const claims = new Map<string, string[]>()
  for (const [providerId, decision] of decisions) {
    if (decision.kind === 'update') {
      claims.set(decision.target, [...(claims.get(decision.target) ?? []), providerId])
    }
  }
  for (const claimants of claims.values()) {
    if (claimants.length < 2) continue
    for (const providerId of claimants) {
      const decision = decisions.get(providerId)!
      if (decision.kind === 'update' && decision.linkedById) continue
      decisions.set(providerId, {
        kind: 'skip',
        reason: `the matching contact was also matched by another ${label} contact`,
      })
    }
  }

  // Pass 3: write.
  const sharedEmailConflicts = (candidate: Candidate): ConflictEntry[] =>
    candidate.sharedEmails.map(email => ({
      field: 'shared_email',
      value_a: email,
      value_b: `Also on other ${label} contacts`,
      source_a: platform,
      source_b: platform,
    }))

  const skip = (candidate: Candidate, reason: string) => {
    const message = `${candidate.providerId}: not linked, ${reason}`
    console.warn(`${platform} import skipped ${message}`)
    result.skipped.push(message)
  }

  const updateExisting = async (candidate: Candidate, target: string, attachLink: boolean) => {
    try {
      const outcome = await mergeImportedContact(
        db,
        userId,
        target,
        candidate.fields,
        attachLink ? { platform, platform_id: candidate.providerId } : null,
        { local: 'local', provider: platform }
      )
      result.conflicts += outcome.conflicts.length
      result.filledFields += outcome.filled.length
      result.conflicts += await fileConflictsOnce(db, userId, target, sharedEmailConflicts(candidate))
      result.updated++
    } catch (error) {
      if (!(error instanceof LinkConflictError)) throw error
      skip(candidate, 'the provider id was linked to another contact while this import was running')
    }
  }

  for (const candidate of candidates) {
    const decision = decisions.get(candidate.providerId)!
    try {
      if (decision.kind === 'skip') {
        skip(candidate, decision.reason)
      } else if (decision.kind === 'update') {
        // Attach a link when the contact has none, or when it is the one this
        // very id already points at (to touch last_synced_at). A throwaway id is
        // never stored.
        await updateExisting(candidate, decision.target, candidate.stableId && (decision.linkedById || !decision.hasLink))
      } else {
        try {
          const created = await createContact(db, userId, {
            fields: {
              ...candidate.fields,
              display_name: candidate.fields.display_name || 'Unknown',
              is_financial_advisor: isLikelyFinancialAdvisor(candidate.emails.map(e => e.email)),
            },
            emails: candidate.emails.map((e, i) => ({ value: e.email, label: e.label, is_primary: i === 0 })),
            phones: candidate.phones.map((p, i) => ({
              value: p.phone,
              label: p.label,
              is_primary: i === 0,
              key: phoneKey(p.phone, p.canonicalForm),
            })),
            links: candidate.stableId ? [{ platform, platform_id: candidate.providerId }] : [],
          })
          result.conflicts += await fileConflictsOnce(db, userId, created, sharedEmailConflicts(candidate))
          if (candidate.sharedEmails.length > 0) result.sharedEmailContacts++
          result.imported++
        } catch (err) {
          // A concurrent import created this provider contact first: the unique
          // link index refused ours and rolled it back. Adopt the winner.
          if (!isUniqueViolation(err)) throw err
          const winner = await findContactByLink(db, platform, candidate.providerId)
          if (!winner) throw err
          await updateExisting(candidate, winner, true)
        }
      }
    } catch (err) {
      result.errors.push(`Error processing contact: ${err}`)
    }
  }

  return result
}
