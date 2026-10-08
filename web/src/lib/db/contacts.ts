import type { RecordId } from 'surrealdb'
import { lastDefined, parseDateTime, recordId, toPlain, type Db } from './client'
import type { ContactDto, ContactFilter, Platform } from './types'

export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 500
export const MAX_BULK_IDS = 1000

const CONTACT_PROJECTION = `
  id, first_name, last_name, display_name, company, job_title, notes,
  is_financial_advisor, created_at, updated_at,
  (SELECT id, contact AS contact_id, email, label, is_primary, created_at
     FROM email WHERE contact = $parent.id ORDER BY is_primary DESC, created_at ASC) AS emails,
  (SELECT id, contact AS contact_id, phone, label, is_primary, created_at
     FROM phone WHERE contact = $parent.id ORDER BY is_primary DESC, created_at ASC) AS phones,
  (SELECT id, contact AS contact_id, platform, platform_id, last_synced_at, sync_hash, created_at
     FROM platform_link WHERE contact = $parent.id ORDER BY created_at ASC) AS platform_links
`

export interface ContactFields {
  first_name?: string | null
  last_name?: string | null
  display_name: string
  company?: string | null
  job_title?: string | null
  notes?: string | null
  is_financial_advisor?: boolean
}

export interface ChannelInput {
  value: string
  label?: string | null
  is_primary?: boolean
}

export interface PlatformLinkInput {
  platform: Platform
  platform_id: string
}

export interface NewContact {
  fields: ContactFields
  emails?: ChannelInput[]
  phones?: ChannelInput[]
  links?: PlatformLinkInput[]
}

export interface ListContactsOptions {
  filter?: ContactFilter | string | null
  search?: string | null
  cursor?: string | null
  limit?: number
}

export class InvalidCursorError extends Error {
  constructor() {
    super('cursor must be an ISO-8601 timestamp')
    this.name = 'InvalidCursorError'
  }
}

export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PAGE_SIZE
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_PAGE_SIZE)
}

export async function listContacts(db: Db, options: ListContactsOptions = {}): Promise<ContactDto[]> {
  const conditions: string[] = []
  const vars: Record<string, unknown> = { limit: clampLimit(options.limit) }

  if (options.filter === 'personal') conditions.push('is_financial_advisor = false')
  else if (options.filter === 'fa') conditions.push('is_financial_advisor = true')

  const search = options.search?.trim().toLowerCase()
  if (search) {
    vars.search = search
    conditions.push(
      "(string::lowercase(first_name ?? '') CONTAINS $search OR string::lowercase(last_name ?? '') CONTAINS $search)"
    )
  }

  if (options.cursor) {
    const cursor = parseDateTime(options.cursor)
    if (!cursor) throw new InvalidCursorError()
    vars.cursor = cursor
    conditions.push('updated_at < $cursor')
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const [rows] = await db
    .query(
      `SELECT ${CONTACT_PROJECTION} FROM contact ${where} ORDER BY updated_at DESC LIMIT $limit`,
      vars
    )
    .collect<[unknown[]]>()
  return toPlain<ContactDto[]>(rows)
}

export async function getContact(db: Db, key: string): Promise<ContactDto | null> {
  const [rows] = await db
    .query(`SELECT ${CONTACT_PROJECTION} FROM contact WHERE id = $id`, {
      id: recordId('contact', key),
    })
    .collect<[unknown[]]>()
  return rows[0] ? toPlain<ContactDto>(rows[0]) : null
}

export async function countContacts(db: Db): Promise<{ total: number; financialAdvisors: number }> {
  const [total, advisors] = await db
    .query(
      `SELECT count() AS n FROM contact GROUP ALL;
       SELECT count() AS n FROM contact WHERE is_financial_advisor = true GROUP ALL`
    )
    .collect<[{ n: number }[], { n: number }[]]>()
  return { total: total[0]?.n ?? 0, financialAdvisors: advisors[0]?.n ?? 0 }
}

const CREATE_CONTACT_SQL = `
BEGIN;
LET $contact = (CREATE ONLY contact CONTENT $content);
FOR $e IN $emails {
  CREATE email CONTENT { owner: $owner, contact: $contact.id, email: $e.value, label: $e.label, is_primary: $e.is_primary };
};
FOR $p IN $phones {
  CREATE phone CONTENT { owner: $owner, contact: $contact.id, phone: $p.value, label: $p.label, is_primary: $p.is_primary };
};
FOR $l IN $links {
  CREATE platform_link CONTENT { owner: $owner, contact: $contact.id, platform: $l.platform, platform_id: $l.platform_id, last_synced_at: time::now() };
};
RETURN $contact.id;
COMMIT;
`

function channels(values: ChannelInput[] | undefined, fallbackLabel: string) {
  return (values ?? []).map((entry, index) => ({
    value: entry.value,
    label: entry.label ?? fallbackLabel,
    is_primary: entry.is_primary ?? index === 0,
  }))
}

// Creates a contact and all of its children atomically: either every row is
// written or none is.
export async function createContact(db: Db, owner: RecordId, input: NewContact): Promise<string> {
  const results = await db
    .query(CREATE_CONTACT_SQL, {
      owner,
      content: {
        owner,
        first_name: input.fields.first_name ?? null,
        last_name: input.fields.last_name ?? null,
        display_name: input.fields.display_name,
        company: input.fields.company ?? null,
        job_title: input.fields.job_title ?? null,
        notes: input.fields.notes ?? null,
        is_financial_advisor: input.fields.is_financial_advisor ?? false,
      },
      emails: channels(input.emails, 'personal'),
      phones: channels(input.phones, 'mobile'),
      links: input.links ?? [],
    })
    .collect()
  const id = lastDefined<RecordId>(results)
  if (!id) throw new Error('Contact creation returned no id.')
  return String(id.id)
}

export interface ContactPatch {
  first_name?: string | null
  last_name?: string | null
  is_financial_advisor?: boolean
}

const PATCHABLE_FIELDS = ['first_name', 'last_name', 'is_financial_advisor'] as const

export async function updateContact(db: Db, key: string, patch: ContactPatch): Promise<boolean> {
  const assignments: string[] = []
  const vars: Record<string, unknown> = { id: recordId('contact', key) }
  for (const field of PATCHABLE_FIELDS) {
    if (patch[field] !== undefined) {
      assignments.push(`${field} = $${field}`)
      vars[field] = patch[field]
    }
  }
  if (assignments.length === 0) {
    assignments.push('updated_at = time::now()')
  }
  const [rows] = await db
    .query(`UPDATE contact SET ${assignments.join(', ')} WHERE id = $id RETURN id`, vars)
    .collect<[unknown[]]>()
  return rows.length > 0
}

export async function deleteContact(db: Db, key: string): Promise<boolean> {
  const [rows] = await db
    .query('DELETE contact WHERE id = $id RETURN BEFORE', { id: recordId('contact', key) })
    .collect<[unknown[]]>()
  return rows.length > 0
}

export async function bulkSetFinancialAdvisor(
  db: Db,
  keys: string[],
  isFinancialAdvisor: boolean
): Promise<string[]> {
  const [rows] = await db
    .query('UPDATE contact SET is_financial_advisor = $flag WHERE id IN $ids RETURN id', {
      flag: isFinancialAdvisor,
      ids: keys.map((key) => recordId('contact', key)),
    })
    .collect<[{ id: RecordId }[]]>()
  return rows.map((row) => String(row.id.id))
}

export interface IdentityIndex {
  // Every contact that owns an address, so duplicates stay visible instead of
  // one silently shadowing another.
  emails: Map<string, Set<string>>
  phones: Array<{ phone: string; contact: string }>
  googleIds: Map<string, string>
  googleLinkByContact: Map<string, string>
}

// Loads every identifier the importers use for duplicate matching. Reads are
// scoped to the session user by table permissions.
export async function loadIdentityIndex(db: Db): Promise<IdentityIndex> {
  const [emails, phones, links] = await db
    .query(
      `SELECT contact, email_lower FROM email;
       SELECT contact, phone FROM phone;
       SELECT contact, platform_id FROM platform_link WHERE platform = 'google'`
    )
    .collect<[
      { contact: RecordId; email_lower: string }[],
      { contact: RecordId; phone: string }[],
      { contact: RecordId; platform_id: string }[],
    ]>()

  const emailIndex = new Map<string, Set<string>>()
  for (const row of emails) {
    const owners = emailIndex.get(row.email_lower) ?? new Set<string>()
    owners.add(String(row.contact.id))
    emailIndex.set(row.email_lower, owners)
  }
  return {
    emails: emailIndex,
    phones: phones.map((row) => ({ phone: row.phone, contact: String(row.contact.id) })),
    googleIds: new Map(links.map((row) => [row.platform_id, String(row.contact.id)])),
    googleLinkByContact: new Map(links.map((row) => [String(row.contact.id), row.platform_id])),
  }
}

export const MERGE_FIELDS = ['first_name', 'last_name', 'display_name', 'company', 'job_title'] as const
export type MergeField = (typeof MERGE_FIELDS)[number]
export type ImportedFields = Record<MergeField, string | null>

export interface MergeOutcome {
  filled: MergeField[]
  conflicts: MergeField[]
}

// The placeholder written when a provider record has no name at all.
const PLACEHOLDER_DISPLAY_NAME = 'Unknown'

function isBlank(field: MergeField, value: string | null | undefined): boolean {
  if (value === null || value === undefined || value.trim() === '') return true
  return field === 'display_name' && value === PLACEHOLDER_DISPLAY_NAME
}

function blankSql(field: MergeField): string {
  const placeholder = field === 'display_name' ? ` OR ${field} = '${PLACEHOLDER_DISPLAY_NAME}'` : ''
  return `(${field} = NONE OR ${field} = NULL OR string::trim(${field}) = ''${placeholder})`
}

// Applies provider data to a contact that was matched on an exact identifier.
// A match is evidence, not permission to overwrite:
//   - values already set locally are kept;
//   - empty local fields are filled;
//   - a different non-empty provider value becomes a conflict for review
//     (once: the same disagreement is not filed again, even after resolution);
//   - is_financial_advisor is never touched; and
//   - the provider link's platform_id is never replaced.
export async function mergeImportedContact(
  db: Db,
  owner: RecordId,
  key: string,
  incoming: ImportedFields,
  link: PlatformLinkInput,
  sources: { local: string; provider: string }
): Promise<MergeOutcome> {
  const id = recordId('contact', key)
  const [contacts, existingConflicts] = await db
    .query(
      `SELECT first_name, last_name, display_name, company, job_title FROM contact WHERE id = $id;
       SELECT field, value_a, value_b FROM conflict WHERE contact = $id`,
      { id }
    )
    .collect<[
      Record<MergeField, string | null | undefined>[],
      { field: string; value_a: string | null; value_b: string | null }[],
    ]>()
  const current = contacts[0]
  if (!current) throw new Error('Matched contact no longer exists.')

  const filled: MergeField[] = []
  const conflicts: { field: MergeField; value_a: string; value_b: string }[] = []
  for (const field of MERGE_FIELDS) {
    const theirs = incoming[field]?.trim()
    if (!theirs) continue
    const mine = current[field]
    if (isBlank(field, mine)) {
      filled.push(field)
    } else if (mine!.trim() !== theirs) {
      const alreadyFiled = existingConflicts.some(
        (row) => row.field === field && row.value_a === mine && row.value_b === theirs
      )
      if (!alreadyFiled) conflicts.push({ field, value_a: mine!, value_b: theirs })
    }
  }

  const vars: Record<string, unknown> = {
    owner,
    id,
    link,
    conflicts: conflicts.map((conflict) => ({
      ...conflict,
      source_a: sources.local,
      source_b: sources.provider,
    })),
  }
  const assignments = filled.map((field) => {
    vars[`fill_${field}`] = incoming[field]!.trim()
    // Re-checked inside the statement so a concurrent edit is never overwritten.
    return `${field} = IF ${blankSql(field)} { $fill_${field} } ELSE { ${field} }`
  })

  await db
    .query(
      `BEGIN;
       ${assignments.length > 0 ? `UPDATE contact SET ${assignments.join(', ')} WHERE id = $id;` : ''}
       FOR $c IN $conflicts {
         CREATE conflict CONTENT {
           owner: $owner, contact: $id, field: $c.field,
           value_a: $c.value_a, value_b: $c.value_b,
           source_a: $c.source_a, source_b: $c.source_b
         };
       };
       INSERT INTO platform_link {
         owner: $owner, contact: $id, platform: $link.platform,
         platform_id: $link.platform_id, last_synced_at: time::now()
       } ON DUPLICATE KEY UPDATE last_synced_at = $input.last_synced_at;
       COMMIT;`,
      vars
    )
    .collect()
  return { filled, conflicts: conflicts.map((conflict) => conflict.field) }
}
