import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { people_v1 } from 'googleapis'
import { RecordId } from 'surrealdb'
import { createContact, getContact, listContacts } from '@/lib/db/contacts'
import { FA_EMAIL_DOMAINS } from '@/lib/fa-detection'
import { finishSyncLog, startSyncLog } from '@/lib/db/sync-logs'
import { normalizePhone, reconcileGoogleContacts } from '@/lib/sync/google'
import { EmptyVcfError, importVcf } from '@/lib/sync/icloud'
import { createTestUser, startTestDatabase, surrealAvailable, type TestDatabase, type TestUser } from './support/surreal'

type Person = people_v1.Schema$Person

const maya: Person = {
  resourceName: 'people/c1001',
  names: [{ givenName: 'Maya', familyName: 'Chen', displayName: 'Maya Chen' }],
  emailAddresses: [{ value: 'Maya@Example.com', type: 'home' }, { value: 'maya.chen@example.org', type: 'work' }],
  phoneNumbers: [{ value: '(202) 555-0143', type: 'mobile' }],
  organizations: [{ name: 'Example Studio', title: 'Designer' }],
}

const advisor: Person = {
  resourceName: 'people/c1002',
  names: [{ givenName: 'Sam', familyName: 'Rivera', displayName: 'Sam Rivera' }],
  emailAddresses: [{ value: `sam@${FA_EMAIL_DOMAINS[0]}` }],
}

const vcard = (body: string) =>
  `BEGIN:VCARD\r\nVERSION:3.0\r\nX-CONTACTKILLER-SYNTHETIC:TRUE\r\n${body}\r\nEND:VCARD\r\n`

describe.skipIf(!surrealAvailable)('provider imports', () => {
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

  describe('Google reconciliation', () => {
    const fresh = async (label: string) => createTestUser(database, label)

    const seedLocal = async (
      user: TestUser,
      fields: Partial<Record<'first_name' | 'last_name' | 'company' | 'job_title', string>> & {
        display_name: string
        is_financial_advisor?: boolean
      },
      channels: { emails?: string[]; phones?: string[]; googleId?: string } = {}
    ) =>
      createContact(user.db, user.id, {
        fields,
        emails: (channels.emails ?? []).map((value) => ({ value })),
        phones: (channels.phones ?? []).map((value) => ({ value })),
        links: channels.googleId ? [{ platform: 'google', platform_id: channels.googleId }] : [],
      })

    const conflictsFor = async (user: TestUser) => {
      const [rows] = await user.db
        .query('SELECT field, value_a, value_b, source_a, source_b, resolved FROM conflict ORDER BY field')
        .collect<[Record<string, unknown>[]]>()
      return rows
    }

    test('imports new contacts with emails, phones, links, and advisor detection', async () => {
      const result = await reconcileGoogleContacts(alice.db, alice.id, [maya, advisor])
      expect(result).toEqual({ imported: 2, updated: 0, conflicts: 0, errors: [], skipped: [], sharedEmailContacts: 0 })

      const contacts = await listContacts(alice.db)
      const imported = contacts.find((c) => c.first_name === 'Maya')!
      expect(imported).toMatchObject({
        last_name: 'Chen',
        display_name: 'Maya Chen',
        company: 'Example Studio',
        job_title: 'Designer',
        is_financial_advisor: false,
      })
      expect(imported.emails.map((e) => [e.email, e.is_primary])).toEqual([
        ['Maya@Example.com', true],
        ['maya.chen@example.org', false],
      ])
      expect(imported.phones.map((p) => p.phone)).toEqual(['(202) 555-0143'])
      expect(imported.platform_links.map((l) => [l.platform, l.platform_id])).toEqual([['google', 'people/c1001']])
      expect(contacts.find((c) => c.first_name === 'Sam')!.is_financial_advisor).toBe(true)
    })

    test('is idempotent: re-running changes nothing and files no duplicate conflicts', async () => {
      const changed: Person = { ...maya, organizations: [{ name: 'Renamed Studio', title: 'Lead' }] }
      const first = await reconcileGoogleContacts(alice.db, alice.id, [changed, advisor])
      expect(first).toEqual({ imported: 0, updated: 2, conflicts: 2, errors: [], skipped: [], sharedEmailContacts: 0 })
      const second = await reconcileGoogleContacts(alice.db, alice.id, [changed, advisor])
      expect(second).toEqual({ imported: 0, updated: 2, conflicts: 0, errors: [], skipped: [], sharedEmailContacts: 0 })

      expect(await listContacts(alice.db)).toHaveLength(2)
      expect(await conflictsFor(alice)).toHaveLength(2)
      const links = (await listContacts(alice.db)).flatMap((c) => c.platform_links)
      expect(links).toHaveLength(2)
      expect(links.every((l) => l.last_synced_at !== null)).toBe(true)
    })

    test('an exact match keeps local values, fills empty ones, and files a conflict for differences', async () => {
      const user = await fresh('merge')
      try {
        const id = await seedLocal(
          user,
          { display_name: 'Maya C.', first_name: 'Maya', company: 'Local Studio', is_financial_advisor: true },
          { emails: ['maya@example.com'] }
        )
        const result = await reconcileGoogleContacts(user.db, user.id, [
          {
            resourceName: 'people/m1',
            names: [{ givenName: 'Maya', familyName: 'Chen', displayName: 'Maya Chen' }],
            emailAddresses: [{ value: 'MAYA@example.com' }],
            organizations: [{ name: 'Google Studio', title: 'Designer' }],
          },
        ])
        expect(result).toEqual({ imported: 0, updated: 1, conflicts: 2, errors: [], skipped: [], sharedEmailContacts: 0 })

        const contact = (await getContact(user.db, id))!
        expect(contact).toMatchObject({
          first_name: 'Maya', // equal, untouched
          last_name: 'Chen', // empty locally, filled
          job_title: 'Designer', // empty locally, filled
          display_name: 'Maya C.', // differs, kept
          company: 'Local Studio', // differs, kept
          is_financial_advisor: true, // never reset
        })
        expect(contact.platform_links.map((l) => l.platform_id)).toEqual(['people/m1'])
        expect(await conflictsFor(user)).toEqual([
          { field: 'company', value_a: 'Local Studio', value_b: 'Google Studio', source_a: 'local', source_b: 'google', resolved: false },
          { field: 'display_name', value_a: 'Maya C.', value_b: 'Maya Chen', source_a: 'local', source_b: 'google', resolved: false },
        ])
      } finally {
        await user.db.close()
      }
    })

    test('a resolved disagreement is not filed again on the next sync', async () => {
      const user = await fresh('resolved')
      try {
        await seedLocal(user, { display_name: 'Pat', company: 'Local Co' }, { emails: ['pat@example.com'] })
        const person: Person = {
          resourceName: 'people/p1',
          names: [{ displayName: 'Pat' }],
          emailAddresses: [{ value: 'pat@example.com' }],
          organizations: [{ name: 'Remote Co' }],
        }
        expect((await reconcileGoogleContacts(user.db, user.id, [person])).conflicts).toBe(1)
        await user.db.query('UPDATE conflict SET resolved = true').collect()
        expect((await reconcileGoogleContacts(user.db, user.id, [person])).conflicts).toBe(0)
        expect(await conflictsFor(user)).toHaveLength(1)
      } finally {
        await user.db.close()
      }
    })

    test('a Google contact with no name never replaces a local name', async () => {
      const user = await fresh('nameless')
      try {
        const id = await seedLocal(user, { display_name: 'Real Name' }, { emails: ['nameless@example.com'] })
        const result = await reconcileGoogleContacts(user.db, user.id, [
          { resourceName: 'people/n1', emailAddresses: [{ value: 'nameless@example.com' }] },
        ])
        expect(result).toMatchObject({ updated: 1, conflicts: 0 })
        expect((await getContact(user.db, id))!.display_name).toBe('Real Name')
      } finally {
        await user.db.close()
      }
    })

    test('matches by email case-insensitively, by exact phone, and by existing Google id', async () => {
      const user = await fresh('matcher')
      try {
        const byEmail = await seedLocal(user, { display_name: 'E' }, { emails: ['Case@Example.com'] })
        const byPhone = await seedLocal(user, { display_name: 'P' }, { phones: ['(202) 555-0143'] })
        const byId = await seedLocal(user, { display_name: 'I' }, { emails: ['old@example.com'], googleId: 'people/x3' })

        const result = await reconcileGoogleContacts(user.db, user.id, [
          { resourceName: 'people/x1', names: [{ displayName: 'E' }], emailAddresses: [{ value: 'case@example.com' }] },
          { resourceName: 'people/x2', names: [{ displayName: 'P' }], phoneNumbers: [{ value: '+1 202 555 0143' }] },
          { resourceName: 'people/x3', names: [{ displayName: 'I' }], emailAddresses: [{ value: 'changed@example.com' }] },
        ])
        expect(result).toEqual({ imported: 0, updated: 3, conflicts: 0, errors: [], skipped: [], sharedEmailContacts: 0 })
        expect((await getContact(user.db, byEmail))!.platform_links[0].platform_id).toBe('people/x1')
        expect((await getContact(user.db, byPhone))!.platform_links[0].platform_id).toBe('people/x2')
        expect((await getContact(user.db, byId))!.platform_links[0].platform_id).toBe('people/x3')
        expect(await listContacts(user.db)).toHaveLength(3)
      } finally {
        await user.db.close()
      }
    })

    describe('exact phone identity', () => {
      const tail = '2025550143'

      test('normalizePhone accepts valid numbers and nothing else', () => {
        expect(normalizePhone('(202) 555-0143')).toBe('+12025550143')
        expect(normalizePhone('+1 202 555 0143')).toBe('+12025550143')
        for (const invalid of ['555-0143', '0143', 'call me', '', `+44${tail}`, `00${tail}`, `1${tail}${tail}`]) {
          expect(normalizePhone(invalid)).toBeNull()
        }
      })

      test('numbers that differ only in area code are different people', () => {
        expect(normalizePhone('(202) 555-0143')).not.toBe(normalizePhone('(212) 555-0143'))
      })

      test('numbers with the same last ten digits but different leading digits do not match', async () => {
        const user = await fresh('digits')
        try {
          await seedLocal(user, { display_name: 'US Number' }, { phones: ['(202) 555-0143'] })
          for (const [index, other] of [`+44${tail}`, `+7${tail}`, `+99${tail}`, `0011${tail}`].entries()) {
            expect(normalizePhone(other)).not.toBe('+12025550143')
            const result = await reconcileGoogleContacts(user.db, user.id, [
              { resourceName: `people/far${index}`, names: [{ displayName: `Far ${index}` }], phoneNumbers: [{ value: other }] },
            ])
            expect(result).toMatchObject({ imported: 1, updated: 0, skipped: [] })
          }
          const usNumber = (await listContacts(user.db)).find((c) => c.display_name === 'US Number')!
          expect(usNumber.platform_links).toEqual([])
        } finally {
          await user.db.close()
        }
      })

      test('a different area code is imported as a separate contact', async () => {
        const user = await fresh('areacode')
        try {
          await seedLocal(user, { display_name: 'Area 202' }, { phones: ['(202) 555-0143'] })
          const result = await reconcileGoogleContacts(user.db, user.id, [
            { resourceName: 'people/a212', names: [{ displayName: 'Area 212' }], phoneNumbers: [{ value: '(212) 555-0143' }] },
          ])
          expect(result).toMatchObject({ imported: 1, updated: 0 })
          expect(await listContacts(user.db)).toHaveLength(2)
        } finally {
          await user.db.close()
        }
      })
    })

    describe('ambiguity never links or merges', () => {
      test('one email shared by two Google contacts: each is imported on its own and none touches the local contact', async () => {
        const user = await fresh('shared')
        try {
          const id = await seedLocal(user, { display_name: 'Local Owner', company: 'Mine' }, { emails: ['shared@example.com'] })
          const people: Person[] = [
            { resourceName: 'people/s1', names: [{ displayName: 'First' }], emailAddresses: [{ value: 'shared@example.com' }], organizations: [{ name: 'One' }] },
            { resourceName: 'people/s2', names: [{ displayName: 'Second' }], emailAddresses: [{ value: 'SHARED@example.com' }], organizations: [{ name: 'Two' }] },
          ]
          const result = await reconcileGoogleContacts(user.db, user.id, people)
          expect(result).toEqual({ imported: 2, updated: 0, conflicts: 2, errors: [], skipped: [], sharedEmailContacts: 2 })

          const local = (await getContact(user.db, id))!
          expect(local).toMatchObject({ display_name: 'Local Owner', company: 'Mine' })
          expect(local.platform_links).toEqual([])

          const contacts = await listContacts(user.db)
          expect(contacts).toHaveLength(3)
          const first = contacts.find((c) => c.display_name === 'First')!
          const second = contacts.find((c) => c.display_name === 'Second')!
          expect(first.id).not.toBe(second.id)
          expect(first.company).toBe('One')
          expect(second.company).toBe('Two')
          expect(first.platform_links.map((l) => l.platform_id)).toEqual(['people/s1'])
          expect(second.platform_links.map((l) => l.platform_id)).toEqual(['people/s2'])

          // Each new contact carries a conflict so the duplicate is visible.
          const [filed] = await user.db
            .query('SELECT contact, field, value_a, source_a, source_b FROM conflict ORDER BY contact')
            .collect<[{ contact: { id: unknown }; field: string; value_a: string }[]]>()
          expect(filed.map((row) => [row.field, row.value_a]).sort()).toEqual([
            ['shared_email', 'shared@example.com'],
            ['shared_email', 'shared@example.com'],
          ])
          expect(new Set(filed.map((row) => String(row.contact.id)))).toEqual(new Set([first.id, second.id]))
        } finally {
          await user.db.close()
        }
      })

      test('re-running with a shared email changes nothing and files nothing new', async () => {
        const user = await fresh('sharedrerun')
        try {
          const people: Person[] = [
            { resourceName: 'people/r1', names: [{ displayName: 'Twin A' }], emailAddresses: [{ value: 'twins@example.com' }] },
            { resourceName: 'people/r2', names: [{ displayName: 'Twin B' }], emailAddresses: [{ value: 'twins@example.com' }] },
          ]
          expect(await reconcileGoogleContacts(user.db, user.id, people)).toMatchObject({ imported: 2, conflicts: 2, sharedEmailContacts: 2 })
          const again = await reconcileGoogleContacts(user.db, user.id, people)
          expect(again).toEqual({ imported: 0, updated: 2, conflicts: 0, errors: [], skipped: [], sharedEmailContacts: 0 })
          expect(await listContacts(user.db)).toHaveLength(2)
          expect(await conflictsFor(user)).toHaveLength(2)
        } finally {
          await user.db.close()
        }
      })

      test('the shared address is not a match key, but their other exact identifiers still are', async () => {
        const user = await fresh('sharedphone')
        try {
          const byPhone = await seedLocal(user, { display_name: 'Phone Match' }, { emails: ['team@example.com'], phones: ['(202) 555-0143'] })
          const result = await reconcileGoogleContacts(user.db, user.id, [
            { resourceName: 'people/q1', names: [{ displayName: 'Phone Match' }], emailAddresses: [{ value: 'team@example.com' }], phoneNumbers: [{ value: '+1 202 555 0143' }] },
            { resourceName: 'people/q2', names: [{ displayName: 'Other Teammate' }], emailAddresses: [{ value: 'team@example.com' }] },
          ])
          expect(result).toMatchObject({ imported: 1, updated: 1, skipped: [] })
          expect((await getContact(user.db, byPhone))!.platform_links.map((l) => l.platform_id)).toEqual(['people/q1'])
          expect(await listContacts(user.db)).toHaveLength(2)
        } finally {
          await user.db.close()
        }
      })

      test('a Google contact never replaces an existing Google link with a different id', async () => {
        const user = await fresh('relink')
        try {
          const id = await seedLocal(user, { display_name: 'Linked', company: 'Keep' }, { emails: ['linked@example.com'], googleId: 'people/original' })
          const result = await reconcileGoogleContacts(user.db, user.id, [
            { resourceName: 'people/impostor', names: [{ displayName: 'Other Person' }], emailAddresses: [{ value: 'linked@example.com' }], organizations: [{ name: 'Other Co' }] },
          ])
          expect(result).toMatchObject({ imported: 0, updated: 0, conflicts: 0 })
          expect(result.skipped).toEqual([expect.stringContaining('already linked to a different Google contact')])

          const contact = (await getContact(user.db, id))!
          expect(contact.platform_links.map((l) => l.platform_id)).toEqual(['people/original'])
          expect(contact).toMatchObject({ display_name: 'Linked', company: 'Keep' })
          expect(await listContacts(user.db)).toHaveLength(1)
        } finally {
          await user.db.close()
        }
      })

      test('two Google contacts reaching one local contact by different identifiers are both skipped', async () => {
        const user = await fresh('claims')
        try {
          const id = await seedLocal(user, { display_name: 'Contested' }, { emails: ['contested@example.com'], phones: ['(202) 555-0143'] })
          const result = await reconcileGoogleContacts(user.db, user.id, [
            { resourceName: 'people/c1', names: [{ displayName: 'By Email' }], emailAddresses: [{ value: 'contested@example.com' }] },
            { resourceName: 'people/c2', names: [{ displayName: 'By Phone' }], phoneNumbers: [{ value: '+1 202 555 0143' }] },
          ])
          expect(result).toMatchObject({ imported: 0, updated: 0 })
          expect(result.skipped).toHaveLength(2)
          expect((await getContact(user.db, id))!.platform_links).toEqual([])
        } finally {
          await user.db.close()
        }
      })

      test('identifiers that match two different local contacts are skipped', async () => {
        const user = await fresh('dupes')
        try {
          await seedLocal(user, { display_name: 'Twin One' }, { emails: ['dupe@example.com'] })
          await seedLocal(user, { display_name: 'Twin Two' }, { emails: ['dupe@example.com'] })
          const result = await reconcileGoogleContacts(user.db, user.id, [
            { resourceName: 'people/d1', names: [{ displayName: 'Dupe' }], emailAddresses: [{ value: 'dupe@example.com' }] },
          ])
          expect(result).toMatchObject({ imported: 0, updated: 0 })
          expect(result.skipped).toEqual([expect.stringContaining('more than one existing contact')])
        } finally {
          await user.db.close()
        }
      })

      test('a phone shared by two Google contacts is not identity evidence', async () => {
        const user = await fresh('landline')
        try {
          const id = await seedLocal(user, { display_name: 'Household' }, { phones: ['(202) 555-0143'] })
          const result = await reconcileGoogleContacts(user.db, user.id, [
            { resourceName: 'people/h1', names: [{ displayName: 'Parent' }], phoneNumbers: [{ value: '(202) 555-0143' }] },
            { resourceName: 'people/h2', names: [{ displayName: 'Child' }], phoneNumbers: [{ value: '202-555-0143' }] },
          ])
          expect(result).toMatchObject({ imported: 2, updated: 0, skipped: [] })
          expect((await getContact(user.db, id))!.platform_links).toEqual([])
        } finally {
          await user.db.close()
        }
      })
    })

    describe('concurrent syncs', () => {
      const roster = (count: number): Person[] =>
        Array.from({ length: count }, (_, index) => ({
          resourceName: `people/race${index}`,
          names: [{ displayName: `Race ${index}` }],
          emailAddresses: [{ value: `race${index}@example.com` }],
        }))

      const linksFor = async (user: TestUser) => {
        const [rows] = await user.db.query('SELECT platform_id FROM platform_link').collect<[{ platform_id: string }[]]>()
        return rows.map((row) => row.platform_id)
      }

      test('the database refuses a second link for one provider identity, even on another contact', async () => {
        const user = await fresh('unique')
        try {
          const first = await seedLocal(user, { display_name: 'First' }, { googleId: 'people/same' })
          const second = await seedLocal(user, { display_name: 'Second' })
          await expect(
            user.db
              .query('CREATE platform_link CONTENT { owner: $owner, contact: $contact, platform: "google", platform_id: "people/same" }', {
                owner: user.id,
                contact: new RecordId('contact', second),
              })
              .collect()
          ).rejects.toThrow(/already contains/)
          expect((await getContact(user.db, first))!.platform_links).toHaveLength(1)
          expect((await getContact(user.db, second))!.platform_links).toEqual([])

          // Another user may legitimately hold the same provider id.
          const other = await fresh('unique-other')
          try {
            await seedLocal(other, { display_name: 'Elsewhere' }, { googleId: 'people/same' })
          } finally {
            await other.db.close()
          }
        } finally {
          await user.db.close()
        }
      })

      test('a sync that loses the race adopts the contact that won instead of failing', async () => {
        const user = await fresh('lostrace')
        try {
          const people = roster(5)
          // The second sync reads the (still empty) identity index, then waits
          // until the first sync has finished before it starts writing.
          let release: () => void = () => undefined
          const firstDone = new Promise<void>((resolve) => {
            release = resolve
          })
          const stale = new Proxy(user.db, {
            get(target, property) {
              const value = Reflect.get(target, property, target)
              if (property !== 'query') return typeof value === 'function' ? value.bind(target) : value
              return (sql: string, vars?: Record<string, unknown>) => {
                const query = target.query(sql, vars)
                if (!sql.includes('FROM platform_link WHERE owner')) return query
                return {
                  collect: async (...args: number[]) => {
                    const rows = await query.collect(...args)
                    await firstDone
                    return rows
                  },
                }
              }
            },
          }) as typeof user.db

          const losing = reconcileGoogleContacts(stale, user.id, people)
          await Bun.sleep(100)
          const winner = await reconcileGoogleContacts(user.db, user.id, people)
          release()
          const loser = await losing

          expect(winner).toMatchObject({ imported: 5, updated: 0, errors: [] })
          expect(loser).toMatchObject({ imported: 0, updated: 5, errors: [], skipped: [] })
          expect(await listContacts(user.db)).toHaveLength(5)
          expect((await linksFor(user)).sort()).toEqual(people.map((p) => p.resourceName!).sort())
        } finally {
          await user.db.close()
        }
      })

      test('truly parallel syncs create each Google contact exactly once', async () => {
        const user = await fresh('parallel')
        try {
          const people = roster(30)
          const runs = await Promise.all([
            reconcileGoogleContacts(user.db, user.id, people),
            reconcileGoogleContacts(user.db, user.id, people),
            reconcileGoogleContacts(user.db, user.id, people),
          ])
          for (const run of runs) expect(run.errors).toEqual([])
          expect(runs.reduce((sum, run) => sum + run.imported, 0)).toBe(30)
          expect(await listContacts(user.db, { limit: 500 })).toHaveLength(30)
          expect((await linksFor(user)).sort()).toEqual(people.map((p) => p.resourceName!).sort())
        } finally {
          await user.db.close()
        }
      })
    })

    test("one user's import never matches or touches another user's contacts", async () => {
      const before = await listContacts(alice.db)
      const result = await reconcileGoogleContacts(bob.db, bob.id, [maya])
      expect(result).toMatchObject({ imported: 1, updated: 0 })
      expect(await listContacts(alice.db)).toEqual(before)
    })

    test('records without a provider id are skipped silently and do not stop the rest', async () => {
      const carol = await fresh('carol')
      try {
        const result = await reconcileGoogleContacts(carol.db, carol.id, [
          { resourceName: 'people/c4001', names: [{ displayName: 'Fine One' }] },
          { names: [{ displayName: 'No Resource Name' }] },
          { resourceName: 'people/c4002', names: [{ displayName: 'Fine Two' }] },
        ])
        expect(result).toEqual({ imported: 2, updated: 0, conflicts: 0, errors: [], skipped: [], sharedEmailContacts: 0 })
        expect(await listContacts(carol.db)).toHaveLength(2)
      } finally {
        await carol.db.close()
      }
    })
  })

  describe('vCard import', () => {
    test('imports cards, extracting names, emails, phones, and organization', async () => {
      const dave = await createTestUser(database, 'dave')
      try {
        const outcome = await importVcf(
          dave.db,
          dave.id,
          vcard('FN:Lena Park\r\nN:Park;Lena;;;\r\nEMAIL;TYPE=WORK:lena@example.com\r\nTEL;TYPE=CELL:+1 202 555 0150\r\nORG:Example Lab\r\nTITLE:Engineer')
        )
        expect(outcome).toEqual({ imported: 1, duplicates: 0, errors: [], total: 1 })

        const [contact] = await listContacts(dave.db)
        expect(contact).toMatchObject({
          first_name: 'Lena',
          last_name: 'Park',
          display_name: 'Lena Park',
          company: 'Example Lab',
          job_title: 'Engineer',
        })
        expect(contact.emails[0]).toMatchObject({ email: 'lena@example.com', is_primary: true })
        expect(contact.phones[0].phone).toContain('555')
        expect(contact.platform_links[0].platform).toBe('icloud')
      } finally {
        await dave.db.close()
      }
    })

    test('re-importing the same file skips duplicates by email, including within one file', async () => {
      const erin = await createTestUser(database, 'erin')
      try {
        const file =
          vcard('FN:Ivo One\r\nEMAIL:ivo@example.com') +
          vcard('FN:Ivo Again\r\nEMAIL:IVO@example.com') +
          vcard('FN:No Email Person\r\nTEL:+1 202 555 0151')
        const first = await importVcf(erin.db, erin.id, file)
        expect(first).toMatchObject({ imported: 2, duplicates: 1, total: 3 })
        const second = await importVcf(erin.db, erin.id, file)
        expect(second).toMatchObject({ imported: 1, duplicates: 2, total: 3 })
        expect(await listContacts(erin.db)).toHaveLength(3)
      } finally {
        await erin.db.close()
      }
    })

    test('imports the repository synthetic fixture (LF line endings)', async () => {
      const frank = await createTestUser(database, 'frank')
      try {
        const fixture = await Bun.file(new URL('../../examples/synthetic/maya-chen.vcf', import.meta.url)).text()
        const outcome = await importVcf(frank.db, frank.id, fixture)
        expect(outcome).toMatchObject({ imported: 1, duplicates: 0, errors: [] })
        const [contact] = await listContacts(frank.db)
        expect(contact).toMatchObject({ first_name: 'Maya', last_name: 'Chen', display_name: 'Maya Chen' })
        expect(contact.emails[0].email).toBe('maya.chen@example.com')
      } finally {
        await frank.db.close()
      }
    })

    test('rejects a file with no cards', async () => {
      await expect(importVcf(alice.db, alice.id, '')).rejects.toBeInstanceOf(EmptyVcfError)
    })
  })

  describe('sync log', () => {
    test('records start and completion for the owner only', async () => {
      const id = await startSyncLog(alice.db, alice.id, 'google', 'full_sync')
      await finishSyncLog(alice.db, id, { status: 'completed', contactsProcessed: 3, conflictsFound: 1 })
      const failed = await startSyncLog(alice.db, alice.id, 'icloud', 'import')
      await finishSyncLog(alice.db, failed, { status: 'failed', errorMessage: 'boom' })

      const [rows] = await alice.db
        .query('SELECT platform, status, contacts_processed, conflicts_found, error_message, completed_at FROM sync_log ORDER BY started_at')
        .collect<[Record<string, unknown>[]]>()
      expect(rows).toMatchObject([
        { platform: 'google', status: 'completed', contacts_processed: 3, conflicts_found: 1, error_message: null },
        { platform: 'icloud', status: 'failed', error_message: 'boom' },
      ])
      expect(rows.every((row) => row.completed_at)).toBe(true)

      const [bobRows] = await bob.db.query('SELECT * FROM sync_log').collect<[unknown[]]>()
      expect(bobRows).toEqual([])
    })
  })
})
