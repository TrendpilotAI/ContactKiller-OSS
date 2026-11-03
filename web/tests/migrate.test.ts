import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
import { connect } from '@/lib/db/client'
import { isSignupEnabledInDatabase, setSignupEnabled } from '@/lib/db/settings'
import { backfillPhoneKeys, createContact } from '@/lib/db/contacts'
import { createTestUser, startTestDatabase, surrealAvailable, type TestDatabase } from './support/surreal'

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
      const tables = async () => {
        const [info] = await isolated.admin.query('INFO FOR DB').collect<[{ tables: Record<string, string> }]>()
        return Object.keys(info.tables)
      }

      for (let index = names.length - 1; index >= 0; index -= 1) {
        expect(await rollbackLatest(isolated.admin, isolated.config, undefined, confirm)).toBe(names[index])
        if (names[index].startsWith('0002')) {
          expect(await tables()).not.toContain('setting')
          expect(await tables()).toContain('contact')
        }
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

  test('rolling back never reopens sign-up, however far it goes', async () => {
    const isolated = await startTestDatabase({ signup: true })
    try {
      const names = (await readMigrations()).map((file) => file.name)
      const gate0002 = names.findIndex((name) => name.startsWith('0002'))
      const signupDirect = async (email: string) => {
        const db = await connect(isolated.config, { kind: 'anonymous' })
        try {
          return await db.signup({
            namespace: isolated.config.namespace,
            database: isolated.config.database,
            access: 'account',
            variables: { email, password: 'correct-horse-battery-1' },
          })
        } finally {
          await db.close()
        }
      }

      // Sign-up is enabled, and stays refused after every rollback step.
      await signupDirect('before@example.com')
      for (let index = names.length - 1; index >= gate0002; index -= 1) {
        await rollbackLatest(isolated.admin, isolated.config, undefined, { confirm: true })
        if (index === gate0002) {
          await expect(signupDirect(`after-${index}@example.com`)).rejects.toThrow('signup_disabled')
        }
      }
      await expect(signupDirect('after-rollback@example.com')).rejects.toThrow('signup_disabled')

      // Re-applying brings the (default-off) gate back; enabling reopens it.
      await migrate(isolated.admin, isolated.config)
      await expect(signupDirect('reapplied@example.com')).rejects.toThrow('signup_disabled')
      await setSignupEnabled(isolated.admin, true)
      expect(await signupDirect('reapplied@example.com')).toHaveProperty('access')
    } finally {
      await isolated.stop()
    }
  })

  test('rolling back phone keys drops the stored values, so re-applying recomputes them instead of resurrecting stale ones', async () => {
    const isolated = await startTestDatabase()
    try {
      const user = await createTestUser(isolated, 'rollbackkeys')
      try {
        const id = await createContact(user.db, user.id, {
          fields: { display_name: 'Keyed' },
          phones: [{ value: '(212) 555-0100' }],
        })
        const read = async () => {
          const [rows] = await isolated.admin
            .query('SELECT phone, phone_key FROM phone')
            .collect<[{ phone: string; phone_key?: string | null }[]]>()
          return rows
        }
        expect(await read()).toEqual([{ phone: '(212) 555-0100', phone_key: '+12125550100' }])

        const names = (await readMigrations()).map((file) => file.name)
        const latest = names[names.length - 1]
        expect(latest.startsWith('0007')).toBe(true)
        expect(await rollbackLatest(isolated.admin, isolated.config, undefined, { confirm: true })).toBe(latest)
        // The stored key is gone with the field.
        expect(await read()).toEqual([{ phone: '(212) 555-0100' }])

        // The number changes while the migration is rolled back.
        await isolated.admin.query("UPDATE phone SET phone = '(202) 555-0143'").collect()

        expect((await migrate(isolated.admin, isolated.config)).applied).toEqual([latest])
        expect(await read()).toEqual([{ phone: '(202) 555-0143' }])

        // Keys are recomputed from the current text.
        expect(await backfillPhoneKeys(user.db)).toBe(1)
        expect(await read()).toEqual([{ phone: '(202) 555-0143', phone_key: '+12025550143' }])
        expect(id).toBeTruthy()
      } finally {
        await user.db.close()
      }
    } finally {
      await isolated.stop()
    }
  })

  test('no down migration leaves field data behind: only 0007 removes a field, and it unsets it first', async () => {
    const dir = new URL('../surreal/migrations/', import.meta.url)
    for (const file of (await readdir(dir)).filter((name) => name.endsWith('.down.surql'))) {
      const sql = await Bun.file(new URL(file, dir)).text()
      if (/REMOVE FIELD/i.test(sql)) {
        expect(sql).toMatch(/UPDATE\s+\w+\s+UNSET\s+\w+;[\s\S]*REMOVE FIELD/i)
      }
    }
  })

  test('only the up file is checksummed: an edited down file is used as written at rollback', async () => {
    const dir = await mkdtemp(join(scratch, 'down-edit-'))
    await writeFile(join(dir, '0001_gadgets.surql'), 'DEFINE TABLE gadget SCHEMALESS;\nDEFINE TABLE gizmo SCHEMALESS;')
    await writeFile(join(dir, '0001_gadgets.down.surql'), 'REMOVE TABLE gadget;')
    const isolated = await startTestDatabase({ migrate: false })
    try {
      await migrate(isolated.admin, isolated.config, dir)
      await writeFile(join(dir, '0001_gadgets.down.surql'), 'REMOVE TABLE gadget;\nREMOVE TABLE gizmo;')
      expect(await rollbackLatest(isolated.admin, isolated.config, dir, { confirm: true })).toBe('0001_gadgets')
      const [info] = await isolated.admin.query('INFO FOR DB').collect<[{ tables: Record<string, string> }]>()
      expect(Object.keys(info.tables)).not.toContain('gadget')
      expect(Object.keys(info.tables)).not.toContain('gizmo')
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

describe.skipIf(!surrealAvailable)('0003 unique platform links', () => {
  test('refuses to run over duplicates, explains the fix, and succeeds once they are resolved', async () => {
    const isolated = await startTestDatabase({ migrate: false })
    const scratch = await mkdtemp(join(tmpdir(), 'ck-0003-'))
    try {
      const all = await readMigrations()
      const before = all.filter((file) => file.name < '0003')
      for (const file of before) await writeFile(join(scratch, `${file.name}.surql`), file.sql)
      await migrate(isolated.admin, isolated.config, scratch)

      const [user] = await isolated.admin
        .query("CREATE app_user SET email = 'dupes@example.com', password_hash = 'x' RETURN id")
        .collect<[{ id: unknown }[]]>()
      const owner = user[0].id
      await isolated.admin
        .query(
          `CREATE contact:one SET owner = $owner, display_name = 'One';
           CREATE contact:two SET owner = $owner, display_name = 'Two';
           CREATE platform_link SET owner = $owner, contact = contact:one, platform = 'google', platform_id = 'people/dup';
           CREATE platform_link SET owner = $owner, contact = contact:two, platform = 'google', platform_id = 'people/dup';`,
          { owner }
        )
        .collect()

      await expect(migrate(isolated.admin, isolated.config)).rejects.toThrow(/several contacts share one \(owner, platform, platform_id\)/)
      await expect(migrate(isolated.admin, isolated.config)).rejects.toThrow(/DELETE the others/)

      const [recorded] = await isolated.admin.query("SELECT name FROM migration WHERE name CONTAINS '0003'").collect<[unknown[]]>()
      expect(recorded).toEqual([])

      await isolated.admin.query('DELETE contact:two').collect()
      const result = await migrate(isolated.admin, isolated.config)
      expect(result.applied.some((name) => name.startsWith('0003'))).toBe(true)

      // The index now holds.
      await isolated.admin
        .query("CREATE contact:three SET owner = $owner, display_name = 'Three'", { owner })
        .collect()
      await expect(
        isolated.admin
          .query("CREATE platform_link SET owner = $owner, contact = contact:three, platform = 'google', platform_id = 'people/dup'", { owner })
          .collect()
      ).rejects.toThrow()
    } finally {
      await isolated.stop()
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!surrealAvailable)('0005 unique conflicts', () => {
  test('refuses to run over duplicate conflicts, explains the fix, and succeeds once they are resolved', async () => {
    const isolated = await startTestDatabase({ migrate: false })
    const scratch = await mkdtemp(join(tmpdir(), 'ck-0005-'))
    try {
      const all = await readMigrations()
      for (const file of all.filter((entry) => entry.name < '0005')) {
        await writeFile(join(scratch, `${file.name}.surql`), file.sql)
      }
      await migrate(isolated.admin, isolated.config, scratch)

      const [user] = await isolated.admin
        .query("CREATE app_user SET email = 'conflicts@example.com', password_hash = 'x' RETURN id")
        .collect<[{ id: unknown }[]]>()
      const owner = user[0].id
      await isolated.admin
        .query(
          `CREATE contact:one SET owner = $owner, display_name = 'One';
           CREATE conflict:first SET owner = $owner, contact = contact:one, field = 'company', value_a = 'A', value_b = 'B';
           CREATE conflict:second SET owner = $owner, contact = contact:one, field = 'company', value_a = 'A', value_b = 'B';`,
          { owner }
        )
        .collect()

      await expect(migrate(isolated.admin, isolated.config)).rejects.toThrow(/filed more than once/)
      await expect(migrate(isolated.admin, isolated.config)).rejects.toThrow(/DELETE the others by id/)
      const [recorded] = await isolated.admin.query("SELECT name FROM migration WHERE name CONTAINS '0005'").collect<[unknown[]]>()
      expect(recorded).toEqual([])

      await isolated.admin.query('DELETE conflict:second').collect()
      const result = await migrate(isolated.admin, isolated.config)
      expect(result.applied.some((name) => name.startsWith('0005'))).toBe(true)

      await expect(
        isolated.admin
          .query("CREATE conflict SET owner = $owner, contact = contact:one, field = 'company', value_a = 'A', value_b = 'B'", { owner })
          .collect()
      ).rejects.toThrow(/conflict_unique_disagreement/)
    } finally {
      await isolated.stop()
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
