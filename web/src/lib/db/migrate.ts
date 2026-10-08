import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from './client'
import type { SurrealConfig } from './config'

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'surreal', 'migrations')

const UP_FILE = /^(\d{4}_[a-z0-9_]+)\.surql$/
const DOWN_FILE = /^(\d{4}_[a-z0-9_]+)\.down\.surql$/

export interface MigrationFile {
  name: string
  sql: string
  checksum: string
}

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

export class MigrationTransactionError extends Error {
  constructor(file: string) {
    super(
      `${file} contains its own BEGIN/COMMIT/CANCEL. The runner wraps every migration ` +
        'in a transaction together with its bookkeeping row; remove the statement.'
    )
    this.name = 'MigrationTransactionError'
  }
}

export class RollbackNotConfirmedError extends Error {
  constructor() {
    super(
      'Rolling back a migration drops schema and data. Pass { confirm: true } ' +
        '(CLI: --confirm or CONTACTKILLER_CONFIRM_ROLLBACK=yes) to proceed.'
    )
    this.name = 'RollbackNotConfirmedError'
  }
}

export class MigrationChecksumError extends Error {
  constructor(name: string) {
    super(
      `Migration ${name} was already applied but its contents have changed. ` +
        'Add a new migration instead of editing an applied one.'
    )
    this.name = 'MigrationChecksumError'
  }
}

// Hash and execute the LF form so a checkout with CRLF line endings produces
// the same checksum as the recorded one.
function normalizeLineEndings(sql: string): string {
  return sql.replace(/\r\n?/g, '\n')
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

const TRANSACTION_STATEMENT = /^\s*(?:BEGIN|COMMIT|CANCEL)\b/im

function assertNoTransactionStatements(file: string, sql: string): void {
  const withoutComments = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  if (TRANSACTION_STATEMENT.test(withoutComments) || /;\s*(?:BEGIN|COMMIT|CANCEL)\b/i.test(withoutComments)) {
    throw new MigrationTransactionError(file)
  }
}

export async function readMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).sort()
  const files: MigrationFile[] = []
  for (const entry of entries) {
    const match = UP_FILE.exec(entry)
    if (!match) continue
    const sql = normalizeLineEndings(await readFile(join(dir, entry), 'utf8'))
    assertNoTransactionStatements(entry, sql)
    files.push({ name: match[1], sql, checksum: checksum(sql) })
  }
  return files
}

// Creates the namespace and database if needed, then selects them. Requires a
// root-scope connection.
export async function prepareDatabase(db: Db, config: SurrealConfig): Promise<void> {
  // Names are validated against /^[A-Za-z0-9_-]+$/ in getSurrealConfig.
  await db
    .query(`DEFINE NAMESPACE IF NOT EXISTS \`${config.namespace}\``)
    .collect()
  await db.use({ namespace: config.namespace })
  await db
    .query(`DEFINE DATABASE IF NOT EXISTS \`${config.database}\``)
    .collect()
  await db.use({ namespace: config.namespace, database: config.database })
  await db
    .query(
      `DEFINE TABLE IF NOT EXISTS migration SCHEMAFULL PERMISSIONS NONE;
       DEFINE FIELD IF NOT EXISTS name ON migration TYPE string;
       DEFINE FIELD IF NOT EXISTS checksum ON migration TYPE string;
       DEFINE FIELD IF NOT EXISTS applied_at ON migration TYPE datetime DEFAULT time::now();
       DEFINE INDEX IF NOT EXISTS migration_name ON migration FIELDS name UNIQUE;`
    )
    .collect()
}

export async function migrate(
  db: Db,
  config: SurrealConfig,
  dir: string = MIGRATIONS_DIR
): Promise<MigrationResult> {
  await prepareDatabase(db, config)
  const [rows] = await db
    .query('SELECT name, checksum FROM migration')
    .collect<[{ name: string; checksum: string }[]]>()
  const applied = new Map(rows.map((row) => [row.name, row.checksum]))

  const result: MigrationResult = { applied: [], skipped: [] }
  for (const file of await readMigrations(dir)) {
    const existing = applied.get(file.name)
    if (existing !== undefined) {
      if (existing !== file.checksum) throw new MigrationChecksumError(file.name)
      result.skipped.push(file.name)
      continue
    }
    // The schema and its bookkeeping row commit together or not at all.
    await db
      .query(
        `BEGIN;
         ${file.sql}
         CREATE migration SET name = $name, checksum = $checksum;
         COMMIT;`,
        { name: file.name, checksum: file.checksum }
      )
      .collect()
    result.applied.push(file.name)
  }
  return result
}

export interface RollbackOptions {
  confirm?: boolean
}

// Rolls back the most recently applied migration using its `.down.surql` file.
// Destructive, so it needs explicit confirmation, and it refuses when the up
// file on disk is not the one that was applied.
export async function rollbackLatest(
  db: Db,
  config: SurrealConfig,
  dir: string = MIGRATIONS_DIR,
  options: RollbackOptions = {}
): Promise<string | null> {
  if (options.confirm !== true) throw new RollbackNotConfirmedError()

  await prepareDatabase(db, config)
  const [rows] = await db
    .query('SELECT name, checksum FROM migration ORDER BY name DESC LIMIT 1')
    .collect<[{ name: string; checksum: string }[]]>()
  const latest = rows[0]
  if (!latest) return null

  const onDisk = (await readMigrations(dir)).find((file) => file.name === latest.name)
  if (!onDisk || onDisk.checksum !== latest.checksum) {
    throw new MigrationChecksumError(latest.name)
  }

  const downFile = (await readdir(dir)).find((entry) => DOWN_FILE.exec(entry)?.[1] === latest.name)
  if (!downFile) throw new Error(`No rollback file (${latest.name}.down.surql) for migration ${latest.name}.`)
  const sql = normalizeLineEndings(await readFile(join(dir, downFile), 'utf8'))
  assertNoTransactionStatements(downFile, sql)
  await db
    .query(
      `BEGIN;
       ${sql}
       DELETE migration WHERE name = $name;
       COMMIT;`,
      { name: latest.name }
    )
    .collect()
  return latest.name
}
