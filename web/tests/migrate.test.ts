import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MigrationChecksumError,
  MigrationTransactionError,
  RollbackNotConfirmedError,
  migrate,
  readMigrations,
  rollbackLatest,
} from '@/lib/db/migrate'
import { isSignupEnabledInDatabase } from '@/lib/db/settings'
import { startTestDatabase, surrealAvailable, type TestDatabase } from './support/surreal'

describe.skipIf(!surrealAvailable)('migrations', () => {
  let database: TestDatabase
  let scratch: string

  beforeAll(async () => {
    database = await startTestDatabase({ migrate: false })
    scratch = await mkdtemp(join(tmpdir(), 'ck-migrations-'))
  })

  afterAll(async () => {
    await database.stop()
    await rm(scratch, { recursive: true, force: true })
  })

  test('the shipped migrations apply once and are idempotent', async () => {
    const shipped = (await readMigrations()).map((file) => file.name)
    expect(shipped.length).toBeGreaterThan(0)

    const first = await migrate(database.admin, database.config)
    expect(first.applied).toEqual(shipped)

    expect(await isSignupEnabledInDatabase(database.admin)).toBe(false)

    const second = await migrate(database.admin, database.config)
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(shipped)

    const [info] = await database.admin.query('INFO FOR DB').collect<[{ tables: Record<string, string>; accesses: Record<string, string> }]>()
    for (const table of ['app_user', 'contact', 'email', 'phone', 'platform_link', 'conflict', 'sync_log', 'oauth_token']) {
      expect(Object.keys(info.tables)).toContain(table)
    }
    expect(Object.keys(info.accesses)).toContain('account')
  })

  test('every user-owned table is owner-scoped', async () => {
    const [info] = await database.admin.query('INFO FOR DB').collect<[{ tables: Record<string, string> }]>()
    for (const table of ['contact', 'email', 'phone', 'platform_link', 'conflict', 'sync_log', 'oauth_token']) {
      expect(info.tables[table]).toContain('owner = $auth')
    }
    expect(info.tables.app_user).toContain('PERMISSIONS NONE')
  })

  test('editing an applied migration is refused', async () => {
    await writeFile(join(scratch, '0001_widgets.surql'), 'DEFINE TABLE widget SCHEMALESS;')
    await migrate(database.admin, database.config, scratch)
    await writeFile(join(scratch, '0001_widgets.surql'), 'DEFINE TABLE widget SCHEMAFULL;')
    await expect(migrate(database.admin, database.config, scratch)).rejects.toBeInstanceOf(MigrationChecksumError)
  })

  test('a failing migration leaves neither schema nor bookkeeping behind', async () => {
    const dir = await mkdtemp(join(scratch, 'failing-'))
    await writeFile(
      join(dir, '0001_half_done.surql'),
      'DEFINE TABLE half_done SCHEMAFULL;\nCREATE half_done:one SET missing_field = 1;\n'
    )
    await expect(migrate(database.admin, database.config, dir)).rejects.toThrow()

    const [info] = await database.admin.query('INFO FOR DB').collect<[{ tables: Record<string, string> }]>()
    expect(Object.keys(info.tables)).not.toContain('half_done')
    const [rows] = await database.admin
      .query("SELECT name FROM migration WHERE name = '0001_half_done'")
      .collect<[unknown[]]>()
    expect(rows).toEqual([])
  })

  test('rollback needs explicit confirmation', async () => {
    await expect(rollbackLatest(database.admin, database.config)).rejects.toBeInstanceOf(RollbackNotConfirmedError)
    await expect(
      rollbackLatest(database.admin, database.config, undefined, { confirm: false })
    ).rejects.toBeInstanceOf(RollbackNotConfirmedError)
  })

  test('rollback unwinds migrations newest first, including schema and records', async () => {
    const isolated = await startTestDatabase({ migrate: false })
    try {
      const names = (await readMigrations()).map((file) => file.name)
      await migrate(isolated.admin, isolated.config)
      const confirm = { confirm: true }

      expect(await rollbackLatest(isolated.admin, isolated.config, undefined, confirm)).toBe(names[names.length - 1])
      const [mid] = await isolated.admin.query('INFO FOR DB').collect<[{ tables: Record<string, string> }]>()
      expect(Object.keys(mid.tables)).not.toContain('setting')
      expect(Object.keys(mid.tables)).toContain('contact')

      for (let index = names.length - 2; index >= 0; index -= 1) {
        expect(await rollbackLatest(isolated.admin, isolated.config, undefined, confirm)).toBe(names[index])
      }
      const [info] = await isolated.admin.query('INFO FOR DB').collect<[{ tables: Record<string, string>; accesses: Record<string, string> }]>()
      expect(Object.keys(info.tables)).not.toContain('contact')
      expect(Object.keys(info.accesses)).not.toContain('account')
      expect(await rollbackLatest(isolated.admin, isolated.config, undefined, confirm)).toBeNull()

      expect((await migrate(isolated.admin, isolated.config)).applied).toEqual(names)
    } finally {
      await isolated.stop()
    }
  })

  test('rollback refuses when the up file no longer matches what was applied', async () => {
    const dir = await mkdtemp(join(scratch, 'drift-'))
    await writeFile(join(dir, '0001_gadgets.surql'), 'DEFINE TABLE gadget SCHEMALESS;')
    await writeFile(join(dir, '0001_gadgets.down.surql'), 'REMOVE TABLE gadget;')
    const isolated = await startTestDatabase({ migrate: false })
    try {
      await migrate(isolated.admin, isolated.config, dir)
      await writeFile(join(dir, '0001_gadgets.surql'), 'DEFINE TABLE gadget SCHEMAFULL;')
      await expect(
        rollbackLatest(isolated.admin, isolated.config, dir, { confirm: true })
      ).rejects.toBeInstanceOf(MigrationChecksumError)
      const [info] = await isolated.admin.query('INFO FOR DB').collect<[{ tables: Record<string, string> }]>()
      expect(Object.keys(info.tables)).toContain('gadget')
    } finally {
      await isolated.stop()
    }
  })

  test('rollback needs a down file', async () => {
    const dir = await mkdtemp(join(scratch, 'no-down-'))
    await writeFile(join(dir, '0001_gadgets.surql'), 'DEFINE TABLE gadget SCHEMALESS;')
    const isolated = await startTestDatabase({ migrate: false })
    try {
      await migrate(isolated.admin, isolated.config, dir)
      await expect(
        rollbackLatest(isolated.admin, isolated.config, dir, { confirm: true })
      ).rejects.toThrow('No rollback file')
    } finally {
      await isolated.stop()
    }
  })

  test('CRLF checkouts hash identically to LF files', async () => {
    const lf = await mkdtemp(join(scratch, 'lf-'))
    const crlf = await mkdtemp(join(scratch, 'crlf-'))
    await writeFile(join(lf, '0001_crlf.surql'), 'DEFINE TABLE a SCHEMALESS;\nDEFINE TABLE b SCHEMALESS;\n')
    await writeFile(join(crlf, '0001_crlf.surql'), 'DEFINE TABLE a SCHEMALESS;\r\nDEFINE TABLE b SCHEMALESS;\r\n')
    expect((await readMigrations(crlf))[0].checksum).toBe((await readMigrations(lf))[0].checksum)
  })

  test('migration files may not manage their own transaction', async () => {
    for (const [index, body] of [
      'BEGIN;\nDEFINE TABLE c SCHEMALESS;\nCOMMIT;',
      'DEFINE TABLE c SCHEMALESS;\n  commit transaction;',
      'DEFINE TABLE c SCHEMALESS; CANCEL;',
    ].entries()) {
      const dir = await mkdtemp(join(scratch, `txn-${index}-`))
      await writeFile(join(dir, '0001_own_txn.surql'), body)
      await expect(readMigrations(dir)).rejects.toBeInstanceOf(MigrationTransactionError)
    }
    const dir = await mkdtemp(join(scratch, 'txn-comment-'))
    await writeFile(join(dir, '0001_ok.surql'), '-- BEGIN and COMMIT are added by the runner\nDEFINE TABLE c SCHEMALESS;')
    expect(await readMigrations(dir)).toHaveLength(1)
  })
})
