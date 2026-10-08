import { DateTime, RecordId, Surreal } from 'surrealdb'
import type { SurrealAdminConfig, SurrealConfig } from './config'

export type Db = Surreal

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const ACCESS_METHOD = 'account'

// Opens a connection that is authenticated as one record user. SurrealDB then
// applies the table permissions in the schema (`owner = $auth`) to every query.
export async function connectWithToken(config: SurrealConfig, token: string): Promise<Db> {
  const db = new Surreal()
  try {
    await db.connect(config.url, {
      namespace: config.namespace,
      database: config.database,
      authentication: token,
      versionCheck: false,
    })
  } catch (error) {
    await db.close().catch(() => undefined)
    throw error
  }
  return db
}

export async function connectAnonymous(config: SurrealConfig): Promise<Db> {
  const db = new Surreal()
  try {
    await db.connect(config.url, {
      namespace: config.namespace,
      database: config.database,
      versionCheck: false,
    })
  } catch (error) {
    await db.close().catch(() => undefined)
    throw error
  }
  return db
}

// Provisioning only: migrations and tests. Connects at root scope so the
// namespace and database can be created before they are selected.
export async function connectAdmin(config: SurrealAdminConfig): Promise<Db> {
  const db = new Surreal()
  try {
    await db.connect(config.url, {
      authentication: { username: config.user, password: config.password },
    })
  } catch (error) {
    await db.close().catch(() => undefined)
    throw error
  }
  return db
}

export async function withDb<T>(db: Db, run: (db: Db) => Promise<T>): Promise<T> {
  try {
    return await run(db)
  } finally {
    await db.close().catch(() => undefined)
  }
}

export function isRecordKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value)
}

export function recordId(table: string, key: string): RecordId {
  if (!isRecordKey(key)) throw new InvalidRecordKeyError(key)
  return new RecordId(table, key)
}

export class InvalidRecordKeyError extends Error {
  constructor(key: unknown) {
    super(`Invalid record id: ${String(key).slice(0, 80)}`)
    this.name = 'InvalidRecordKeyError'
  }
}

export function parseDateTime(value: string): DateTime | null {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return null
  return new DateTime(time)
}

// Converts SDK value classes into JSON-safe values. Record links collapse to
// their bare key because every table in this schema is addressed by table name
// at the API boundary.
export function toPlain<T = unknown>(value: unknown): T {
  if (value instanceof RecordId) return String(value.id) as T
  if (value instanceof DateTime) return value.toISOString() as T
  if (Array.isArray(value)) return value.map((item) => toPlain(item)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toPlain(item)])
    ) as T
  }
  return value as T
}

export function lastDefined<T>(results: unknown[]): T | undefined {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    if (results[index] !== undefined) return results[index] as T
  }
  return undefined
}
