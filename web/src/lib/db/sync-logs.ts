import { DateTime, type RecordId } from 'surrealdb'
import { recordId, type Db } from './client'

export interface SyncLogCompletion {
  status: 'completed' | 'failed'
  contactsProcessed?: number
  conflictsFound?: number
  errorMessage?: string
}

export async function startSyncLog(
  db: Db,
  owner: RecordId,
  platform: string,
  operation: string
): Promise<string> {
  const [rows] = await db
    .query(
      `CREATE sync_log CONTENT { owner: $owner, platform: $platform, operation: $operation, status: 'started' } RETURN id`,
      { owner, platform, operation }
    )
    .collect<[{ id: RecordId }[]]>()
  return String(rows[0].id.id)
}

export async function finishSyncLog(db: Db, key: string, completion: SyncLogCompletion): Promise<void> {
  await db
    .query(
      `UPDATE $id SET
         status = $status,
         contacts_processed = $processed,
         conflicts_found = $conflicts,
         error_message = $error,
         completed_at = $completedAt`,
      {
        id: recordId('sync_log', key),
        status: completion.status,
        processed: completion.contactsProcessed ?? 0,
        conflicts: completion.conflictsFound ?? 0,
        error: completion.errorMessage ?? null,
        completedAt: new DateTime(),
      }
    )
    .collect()
}
