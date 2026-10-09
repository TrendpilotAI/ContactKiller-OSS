import type { RecordId } from 'surrealdb'
import { recordId, runTransaction, toPlain, type Db } from './client'
import type { ConflictDto } from './types'

export type ConflictChoice = 'a' | 'b' | 'skip'

// Conflict fields that map onto a plain column of `contact`. Anything else
// (for example `email` or `phone`, which live in child tables) needs a
// reviewed merge and cannot be applied through the A/B shortcut.
export const RESOLVABLE_FIELDS = [
  'first_name',
  'last_name',
  'display_name',
  'company',
  'job_title',
  'notes',
] as const

type ResolvableField = (typeof RESOLVABLE_FIELDS)[number]

export type ResolveOutcome =
  | { status: 'resolved' }
  | { status: 'not_found' }
  | { status: 'already_resolved' }
  | { status: 'unsupported_field'; field: string }

export function isChoice(value: unknown): value is ConflictChoice {
  return value === 'a' || value === 'b' || value === 'skip'
}

function isResolvableField(field: string): field is ResolvableField {
  return (RESOLVABLE_FIELDS as readonly string[]).includes(field)
}

export interface NewConflict {
  contactKey: string
  field: string
  value_a: string | null
  value_b: string | null
  source_a: string | null
  source_b: string | null
}

export async function createConflict(db: Db, owner: RecordId, input: NewConflict): Promise<string> {
  const [rows] = await db
    .query(
      `CREATE conflict CONTENT {
         owner: $owner, contact: $contact, field: $field,
         value_a: $value_a, value_b: $value_b, source_a: $source_a, source_b: $source_b
       } RETURN id`,
      {
        owner,
        contact: recordId('contact', input.contactKey),
        field: input.field,
        value_a: input.value_a,
        value_b: input.value_b,
        source_a: input.source_a,
        source_b: input.source_b,
      }
    )
    .collect<[{ id: RecordId }[]]>()
  return String(rows[0].id.id)
}

export async function listUnresolvedConflicts(db: Db): Promise<ConflictDto[]> {
  const [rows] = await db
    .query(
      `SELECT id, contact AS contact_id, field, value_a, value_b, source_a, source_b,
              resolved, resolved_value, created_at, resolved_at,
              contact.{ first_name, last_name } AS contact
         FROM conflict WHERE owner = $auth AND resolved = false ORDER BY created_at DESC`
    )
    .collect<[unknown[]]>()
  return toPlain<ConflictDto[]>(rows)
}

// The first statement of the transaction claims the conflict: it flips
// `resolved` only if it is still false, and aborts everything otherwise. Two
// resolvers racing for one conflict therefore cannot both apply a value; the
// loser (after SurrealDB's own write-conflict retry) finds it resolved.
const CLAIM_SQL = `
  LET $claimed = (UPDATE $id SET resolved = true, resolved_value = $value, resolved_at = time::now()
                  WHERE resolved = false RETURN id);
  IF array::len($claimed) = 0 {
    IF array::len((SELECT id FROM $id)) = 0 { THROW "conflict_not_found"; };
    THROW "already_resolved";
  };`

export async function resolveConflict(
  db: Db,
  key: string,
  choice: ConflictChoice
): Promise<ResolveOutcome> {
  const id = recordId('conflict', key)
  const [rows] = await db
    .query('SELECT contact, field, value_a, value_b, resolved FROM $id', { id })
    .collect<[{ contact: RecordId; field: string; value_a: string | null; value_b: string | null; resolved: boolean }[]]>()
  const conflict = rows[0]
  if (!conflict) return { status: 'not_found' }
  if (conflict.resolved) return { status: 'already_resolved' }

  let sql: string
  const vars: Record<string, unknown> = { id }
  if (choice === 'skip') {
    // Dismissed: resolved without applying anything.
    sql = `BEGIN;${CLAIM_SQL}\nCOMMIT;`
    vars.value = null
  } else {
    if (!isResolvableField(conflict.field)) {
      return { status: 'unsupported_field', field: conflict.field }
    }
    // `conflict.field` is checked against RESOLVABLE_FIELDS above, so it is
    // safe to use as an identifier here.
    sql = `BEGIN;${CLAIM_SQL}
      UPDATE $contact SET ${conflict.field} = $value;
      COMMIT;`
    vars.contact = conflict.contact
    vars.value = choice === 'a' ? conflict.value_a : conflict.value_b
  }

  try {
    await runTransaction(db, sql, vars)
    return { status: 'resolved' }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/already_resolved/.test(message)) return { status: 'already_resolved' }
    if (/conflict_not_found/.test(message)) return { status: 'not_found' }
    throw error
  }
}
