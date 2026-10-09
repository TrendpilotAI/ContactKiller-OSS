import { DateTime, RecordId, Surreal } from 'surrealdb'
import type { SurrealConfig } from './config'

export type Db = Surreal

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const ACCESS_METHOD = 'account'

export type Credentials =
  // A record user's session token: SurrealDB then applies the schema's table
  // permissions (`owner = $auth`) to every query on the connection.
  | { kind: 'token'; token: string }
  // No identity; only usable for the access method's signup and signin.
  | { kind: 'anonymous' }
  // Root scope, for provisioning (migrations, tests). Connects before the
  // namespace and database exist, so neither is selected.
  | { kind: 'root'; user: string; password: string }

export async function connect(config: SurrealConfig, credentials: Credentials): Promise<Db> {
  const db = new Surreal()
  try {
    switch (credentials.kind) {
      case 'token':
        await db.connect(config.url, {
          namespace: config.namespace,
          database: config.database,
          authentication: credentials.token,
          versionCheck: false,
        })
        break
      case 'anonymous':
        await db.connect(config.url, {
          namespace: config.namespace,
          database: config.database,
          versionCheck: false,
        })
        break
      case 'root':
        await db.connect(config.url, {
          authentication: { username: credentials.user, password: credentials.password },
        })
        break
      default: {
        const unreachable: never = credentials
        throw new Error(`Unsupported credentials: ${String(unreachable)}`)
      }
    }
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

const RETRYABLE_CONFLICT = /Transaction conflict|can be retried/i
const MAX_TRANSACTION_ATTEMPTS = 6

// Runs a multi-statement transaction and throws the error that actually caused
// it to fail. When a statement inside BEGIN/COMMIT fails, SurrealDB reports
// every other statement as "not executed due to a failed transaction", and
// `collect()` would surface one of those instead of the real cause. Returns the
// per-statement results for the caller to pick from.
//
// Optimistic write conflicts between concurrent transactions roll the whole
// transaction back, so they are retried (with jitter) a bounded number of times.
export async function runTransaction(
  db: Db,
  sql: string,
  vars?: Record<string, unknown>
): Promise<unknown[]> {
  for (let attempt = 1; ; attempt += 1) {
    const responses = await db.query(sql, vars).responses()
    const failures = responses.filter((response) => !response.success)
    if (failures.length === 0) {
      return responses.map((response) => (response.success ? response.result : undefined))
    }

    const secondary = /not executed due to a failed transaction|transaction was cancelled/i
    const cause =
      failures.find((failure) => !failure.success && !secondary.test(failure.error.message)) ?? failures[0]
    const error = (cause as { error: Error }).error
    if (RETRYABLE_CONFLICT.test(error.message) && attempt < MAX_TRANSACTION_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 25 * attempt))
      continue
    }
    throw error
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
