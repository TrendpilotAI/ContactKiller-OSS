import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RecordId } from 'surrealdb'
import {
  InvalidCursorError,
  bulkSetFinancialAdvisor,
  countContacts,
  createContact,
  deleteContact,
  getContact,
  listContacts,
  updateContact,
} from '@/lib/db/contacts'
import { InvalidRecordKeyError, parseDateTime } from '@/lib/db/client'
import { createTestUser, startTestDatabase, surrealAvailable, type TestDatabase, type TestUser } from './support/surreal'

async function rowCount(database: TestDatabase, table: string): Promise<number> {
  const [rows] = await database.admin.query(`SELECT * FROM ${table}`).collect<[unknown[]]>()
  return rows.length
}

describe.skipIf(!surrealAvailable)('contacts persistence', () => {
  let database: TestDatabase
  let alice: TestUser
  let bob: TestUser

  beforeAll(async () => {
    database = await startTestDatabase()
    alice = await createTestUser(database, 'alice')
    bob = await createTestUser(database, 'bob')
  })
  afterAll(async () => {
    await alice.db.close()
    await bob.db.close()
    await database.stop()
  })

  test('creates a contact with emails, phones, and links, and reads it back', async () => {
    const id = await createContact(alice.db, alice.id, {
      fields: { first_name: 'Maya', last_name: 'Chen', display_name: 'Maya Chen' },
      emails: [{ value: 'maya@example.com' }, { value: 'maya.work@example.com', label: 'work' }],
      phones: [{ value: '+1 202 555 0143' }],
      links: [{ platform: 'google', platform_id: 'people/c1' }],
    })

    const contact = await getContact(alice.db, id)
    expect(contact).not.toBeNull()
    expect(contact).toMatchObject({
      id,
      first_name: 'Maya',
      last_name: 'Chen',
      display_name: 'Maya Chen',
      is_financial_advisor: false,
    })
    expect(contact!.emails.map((e) => [e.email, e.label, e.is_primary, e.contact_id])).toEqual([
      ['maya@example.com', 'personal', true, id],
      ['maya.work@example.com', 'work', false, id],
    ])
    expect(contact!.phones[0]).toMatchObject({ phone: '+1 202 555 0143', label: 'mobile', is_primary: true })
    expect(contact!.platform_links[0]).toMatchObject({ platform: 'google', platform_id: 'people/c1' })
    expect(typeof contact!.created_at).toBe('string')
    expect(JSON.stringify(contact)).not.toContain('owner')
  })

  test('creation is atomic: a bad child row rolls back the whole contact', async () => {
    const before = {
      contact: await rowCount(database, 'contact'),
      email: await rowCount(database, 'email'),
    }
    await expect(
      createContact(alice.db, alice.id, {
        fields: { display_name: 'Rollback Person' },
        emails: [{ value: 'rollback@example.com' }],
        // @ts-expect-error exercising the schema assertion with an unknown platform
        links: [{ platform: 'myspace', platform_id: 'x' }],
      })
    ).rejects.toThrow()
    expect(await rowCount(database, 'contact')).toBe(before.contact)
    expect(await rowCount(database, 'email')).toBe(before.email)
  })

  test('updated_at moves on update and created_at does not', async () => {
    const id = await createContact(alice.db, alice.id, { fields: { display_name: 'Timestamp Person', first_name: 'Tim' } })
    const before = (await getContact(alice.db, id))!
    await Bun.sleep(15)
    expect(await updateContact(alice.db, id, { first_name: 'Timothy' })).toBe(true)
    const after = (await getContact(alice.db, id))!
    expect(after.first_name).toBe('Timothy')
    expect(after.created_at).toBe(before.created_at)
    expect(after.updated_at > before.updated_at).toBe(true)
  })

  test('PATCH semantics: undefined keeps, null clears, unknown ids are not created', async () => {
    const id = await createContact(alice.db, alice.id, {
      fields: { display_name: 'Patch Person', first_name: 'Pat', last_name: 'Ient' },
    })
    await updateContact(alice.db, id, { last_name: null })
    expect(await getContact(alice.db, id)).toMatchObject({ first_name: 'Pat', last_name: null })

    expect(await updateContact(alice.db, 'doesnotexist', { first_name: 'Ghost' })).toBe(false)
    expect(await getContact(alice.db, 'doesnotexist')).toBeNull()
    expect(await rowCount(database, 'contact:doesnotexist')).toBe(0)
  })

  test('lists with filters, case-insensitive literal search, and cursor pagination', async () => {
    const searchUser = await createTestUser(database, 'lister')
    try {
      const names = ['Ada', 'Bea', 'Cal', 'Dee', 'Eli']
      for (const [index, name] of names.entries()) {
        await createContact(searchUser.db, searchUser.id, {
          fields: {
            first_name: name,
            last_name: index === 0 ? '50%_Off' : 'Tester',
            display_name: `${name} Tester`,
            is_financial_advisor: index % 2 === 0,
          },
        })
        await Bun.sleep(5)
      }

      const all = await listContacts(searchUser.db)
      expect(all.map((c) => c.first_name)).toEqual(['Eli', 'Dee', 'Cal', 'Bea', 'Ada'])

      expect((await listContacts(searchUser.db, { filter: 'fa' })).map((c) => c.first_name)).toEqual(['Eli', 'Cal', 'Ada'])
      expect((await listContacts(searchUser.db, { filter: 'personal' })).map((c) => c.first_name)).toEqual(['Dee', 'Bea'])
      expect((await listContacts(searchUser.db, { search: 'CAL' })).map((c) => c.first_name)).toEqual(['Cal'])
      // % and _ are literal characters, not wildcards
      expect((await listContacts(searchUser.db, { search: '%' })).map((c) => c.first_name)).toEqual(['Ada'])
      expect(await listContacts(searchUser.db, { search: 'a_' })).toEqual([])
      // user input is a bound parameter, never query text
      expect(await listContacts(searchUser.db, { search: "x') OR true OR ('" })).toEqual([])

      const pageOne = await listContacts(searchUser.db, { limit: 2 })
      expect(pageOne.map((c) => c.first_name)).toEqual(['Eli', 'Dee'])
      const pageTwo = await listContacts(searchUser.db, { limit: 2, cursor: pageOne[1].updated_at })
      expect(pageTwo.map((c) => c.first_name)).toEqual(['Cal', 'Bea'])
      const pageThree = await listContacts(searchUser.db, { limit: 2, cursor: pageTwo[1].updated_at })
      expect(pageThree.map((c) => c.first_name)).toEqual(['Ada'])

      await expect(listContacts(searchUser.db, { cursor: 'yesterday-ish' })).rejects.toBeInstanceOf(InvalidCursorError)
      expect(await countContacts(searchUser.db)).toEqual({ total: 5, financialAdvisors: 3 })
    } finally {
      await searchUser.db.close()
    }
  })

  test('cursor pagination keeps nanosecond precision: rows sharing a millisecond are not skipped', async () => {
    const pager = await createTestUser(database, 'pager')
    try {
      // One query, so the timestamps differ by nanoseconds and most share a ms.
      await pager.db
        .query('FOR $i IN 0..12 { CREATE contact SET owner = $owner, display_name = string::concat("row-", <string>$i) }', {
          owner: pager.id,
        })
        .collect()

      const all = await listContacts(pager.db, { limit: 100 })
      expect(all).toHaveLength(12)
      const millis = all.map((c) => c.updated_at.slice(0, 23))
      const largestBucket = Math.max(...[...new Set(millis)].map((ms) => millis.filter((m) => m === ms).length))
      expect(largestBucket).toBeGreaterThanOrEqual(3)

      const pages: string[][] = []
      let cursor: string | null = null
      for (let guard = 0; guard < 20; guard += 1) {
        const page: Awaited<ReturnType<typeof listContacts>> = await listContacts(pager.db, {
          limit: 3,
          cursor: cursor ?? undefined,
        })
        if (page.length === 0) break
        pages.push(page.map((c) => c.display_name))
        cursor = page.length === 3 ? page[page.length - 1].updated_at : null
        if (!cursor) break
      }

      expect(pages.flat()).toHaveLength(12)
      expect(new Set(pages.flat()).size).toBe(12)
      expect(pages.flat()).toEqual(all.map((c) => c.display_name))
    } finally {
      await pager.db.close()
    }
  })

  test('a cursor keeps the precision it was issued with, and anything that is not a date is null', () => {
    const issued = '2026-10-09T14:28:09.635843977Z'
    expect(parseDateTime(issued)?.toISOString()).toBe(issued)
    expect(parseDateTime('2026-10-09T14:28:09.635Z')?.toISOString()).toBe('2026-10-09T14:28:09.635Z')
    for (const bad of ['yesterday-ish', '', 'null', '2026-13-45T99:99:99Z']) {
      expect(parseDateTime(bad)).toBeNull()
    }
  })

  test('bulk tagging updates only the requested contacts', async () => {
    const taggedUser = await createTestUser(database, 'tagger')
    try {
      const ids: string[] = []
      for (const name of ['One', 'Two', 'Three']) {
        ids.push(await createContact(taggedUser.db, taggedUser.id, { fields: { display_name: name } }))
      }
      const updated = await bulkSetFinancialAdvisor(taggedUser.db, [ids[0], ids[1], 'missing'], true)
      expect(updated.sort()).toEqual([ids[0], ids[1]].sort())
      expect((await getContact(taggedUser.db, ids[2]))!.is_financial_advisor).toBe(false)
      expect(await countContacts(taggedUser.db)).toEqual({ total: 3, financialAdvisors: 2 })
    } finally {
      await taggedUser.db.close()
    }
  })

  test('deleting a contact cascades to every child table', async () => {
    const id = await createContact(alice.db, alice.id, {
      fields: { display_name: 'Cascade Person' },
      emails: [{ value: 'cascade@example.com' }],
      phones: [{ value: '+1 202 555 0144' }],
      links: [{ platform: 'icloud', platform_id: 'icloud-1' }],
    })
    await database.admin.query(
      `CREATE conflict CONTENT { owner: $owner, contact: $contact, field: 'company', value_a: 'A', value_b: 'B' }`,
      { owner: alice.id, contact: new RecordId('contact', id) }
    ).collect()

    expect(await deleteContact(alice.db, id)).toBe(true)
    expect(await deleteContact(alice.db, id)).toBe(false)

    for (const table of ['email', 'phone', 'platform_link', 'conflict']) {
      const [rows] = await database.admin
        .query(`SELECT * FROM ${table} WHERE contact = $contact`, { contact: new RecordId('contact', id) })
        .collect<[unknown[]]>()
      expect(rows).toEqual([])
    }
  })

  test('platform links are unique per contact and platform', async () => {
    const id = await createContact(alice.db, alice.id, {
      fields: { display_name: 'Link Person' },
      links: [{ platform: 'google', platform_id: 'people/c9' }],
    })
    await expect(
      alice.db
        .query('CREATE platform_link CONTENT { owner: $owner, contact: $contact, platform: "google", platform_id: "people/c10" }', {
          owner: alice.id,
          contact: new RecordId('contact', id),
        })
        .collect()
    ).rejects.toThrow()
  })

  test('malformed ids are rejected before they reach the database', async () => {
    await expect(getContact(alice.db, 'a b; DELETE contact')).rejects.toBeInstanceOf(InvalidRecordKeyError)
    await expect(deleteContact(alice.db, '')).rejects.toBeInstanceOf(InvalidRecordKeyError)
    await expect(bulkSetFinancialAdvisor(alice.db, ['ok', '../x'], true)).rejects.toBeInstanceOf(InvalidRecordKeyError)
  })

  describe('tenant isolation', () => {
    let aliceContact: string

    beforeAll(async () => {
      aliceContact = await createContact(alice.db, alice.id, {
        fields: { display_name: 'Alice Private', first_name: 'Alice' },
        emails: [{ value: 'alice.private@example.com' }],
        phones: [{ value: '+1 202 555 0145' }],
        links: [{ platform: 'google', platform_id: 'people/alice' }],
      })
    })

    test("another user cannot read, list, count, update, or delete someone else's contact", async () => {
      expect(await getContact(bob.db, aliceContact)).toBeNull()
      expect(await listContacts(bob.db)).toEqual([])
      expect(await countContacts(bob.db)).toEqual({ total: 0, financialAdvisors: 0 })
      expect(await updateContact(bob.db, aliceContact, { first_name: 'Hijacked' })).toBe(false)
      expect(await bulkSetFinancialAdvisor(bob.db, [aliceContact], true)).toEqual([])
      expect(await deleteContact(bob.db, aliceContact)).toBe(false)

      const intact = await getContact(alice.db, aliceContact)
      expect(intact).toMatchObject({ first_name: 'Alice', is_financial_advisor: false })
      expect(intact!.emails).toHaveLength(1)
    })

    test('child tables are isolated too', async () => {
      for (const table of ['email', 'phone', 'platform_link', 'conflict', 'sync_log', 'oauth_token']) {
        const [rows] = await bob.db.query(`SELECT * FROM ${table}`).collect<[unknown[]]>()
        expect(rows).toEqual([])
      }
    })

    // SurrealDB reports a denied CREATE as an empty result rather than an error,
    // so these assert on what was actually persisted.
    test('a user cannot create rows owned by someone else', async () => {
      const [result] = await bob.db
        .query('CREATE contact CONTENT { owner: $owner, display_name: "Planted" }', { owner: alice.id })
        .collect<[unknown[]]>()
      expect(result).toEqual([])
      const [rows] = await database.admin
        .query('SELECT * FROM contact WHERE display_name = "Planted"')
        .collect<[unknown[]]>()
      expect(rows).toEqual([])
    })

    test("a user cannot attach child rows to someone else's contact", async () => {
      const target = new RecordId('contact', aliceContact)
      for (const [table, content] of [
        ['email', '{ owner: $owner, contact: $contact, email: "planted@example.com" }'],
        ['phone', '{ owner: $owner, contact: $contact, phone: "+1 202 555 0199" }'],
        ['platform_link', '{ owner: $owner, contact: $contact, platform: "google", platform_id: "planted" }'],
        ['conflict', '{ owner: $owner, contact: $contact, field: "company" }'],
      ] as const) {
        const [result] = await bob.db
          .query(`CREATE ${table} CONTENT ${content}`, { owner: bob.id, contact: target })
          .collect<[unknown[]]>()
        expect(result).toEqual([])
      }
      for (const table of ['email', 'phone', 'platform_link', 'conflict']) {
        const [rows] = await database.admin
          .query(`SELECT * FROM ${table} WHERE owner = $bob`, { bob: bob.id })
          .collect<[unknown[]]>()
        expect(rows).toEqual([])
      }
      expect((await getContact(alice.db, aliceContact))!.emails.map((e) => e.email)).toEqual(['alice.private@example.com'])
    })

    test('ownership and parentage cannot be reassigned', async () => {
      const mine = await createContact(bob.db, bob.id, {
        fields: { display_name: 'Bob Own' },
        emails: [{ value: 'bob@example.com' }],
      })
      await expect(
        bob.db.query('UPDATE contact SET owner = $alice WHERE id = $id', { alice: alice.id, id: new RecordId('contact', mine) }).collect()
      ).rejects.toThrow()
      await expect(
        bob.db
          .query('UPDATE email SET contact = $other WHERE contact = $id', {
            other: new RecordId('contact', aliceContact),
            id: new RecordId('contact', mine),
          })
          .collect()
      ).rejects.toThrow()
      expect((await getContact(bob.db, mine))!.emails).toHaveLength(1)
    })
  })
})
