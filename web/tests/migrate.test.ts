import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MigrationChecksumError, migrate, readMigrations, rollbackLatest } from '@/lib/db/migrate'
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

  test('rollback removes the latest migration, its schema, and its record', async () => {
    const isolated = await startTestDatabase({ migrate: false })
    try {
      const [{ name }] = await readMigrations()
      await migrate(isolated.admin, isolated.config)

      expect(await rollbackLatest(isolated.admin, isolated.config)).toBe(name)
      const [info] = await isolated.admin.query('INFO FOR DB').collect<[{ tables: Record<string, string>; accesses: Record<string, string> }]>()
      expect(Object.keys(info.tables)).not.toContain('contact')
      expect(Object.keys(info.accesses)).not.toContain('account')
      expect(await rollbackLatest(isolated.admin, isolated.config)).toBeNull()

      expect((await migrate(isolated.admin, isolated.config)).applied).toEqual([name])
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
      await expect(rollbackLatest(isolated.admin, isolated.config, dir)).rejects.toThrow('No rollback file')
    } finally {
      await isolated.stop()
    }
  })
})
