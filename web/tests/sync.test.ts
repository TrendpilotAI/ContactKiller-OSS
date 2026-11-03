import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { people_v1 } from 'googleapis'
import { RecordId } from 'surrealdb'
import { backfillPhoneKeys, createContact, fileConflictsOnce, findContactByLink, getContact, listContacts } from '@/lib/db/contacts'
import { FA_EMAIL_DOMAINS } from '@/lib/fa-detection'
import { finishSyncLog, startSyncLog } from '@/lib/db/sync-logs'
import { normalizePhone, reconcileGoogleContacts } from '@/lib/sync/google'
import { phoneKey } from '@/lib/sync/phone'
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

// Wraps a connection so the identity-index read returns what it saw but then
// waits: the caller decides who to link while the world moves underneath it.
function withHeldIdentityIndex(db: TestUser['db'], needle = 'platform = $platform') {
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const stale = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property !== 'query') return typeof value === 'function' ? value.bind(target) : value
      return (sql: string, vars?: Record<string, unknown>) => {
        const query = target.query(sql, vars)
        if (!sql.includes(needle)) return query
        // Only the read is held; every other method behaves as usual.
        return new Proxy(query, {
          get(queryTarget, queryProperty) {
            const member = Reflect.get(queryTarget, queryProperty, queryTarget)
            if (queryProperty !== 'collect') return typeof member === 'function' ? member.bind(queryTarget) : member
            return async (...args: number[]) => {
              const rows = await queryTarget.collect(...args)
              await held
              return rows
            }
          },
        })
      }
    },
  }) as typeof db
  return { stale, release }
}

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

  describe('Google reconciliation', () => {
    const fresh = async (label: string) => createTestUser(database, label)

    const conflictsFor = async (user: TestUser) => {
      const [rows] = await user.db
        .query('SELECT field, value_a, value_b, source_a, source_b, resolved FROM conflict ORDER BY field')
        .collect<[Record<string, unknown>[]]>()
      return rows
    }

    test('imports new contacts with emails, phones, links, and advisor detection', async () => {
      const result = await reconcileGoogleContacts(alice.db, alice.id, [maya, advisor])
      expect(result).toMatchObject({ imported: 2, updated: 0, conflicts: 0, errors: [], skipped: [], sharedEmailContacts: 0 })

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
      expect(first).toMatchObject({ imported: 0, updated: 2, conflicts: 2, errors: [], skipped: [], sharedEmailContacts: 0 })
      const second = await reconcileGoogleContacts(alice.db, alice.id, [changed, advisor])
      expect(second).toMatchObject({ imported: 0, updated: 2, conflicts: 0, errors: [], skipped: [], sharedEmailContacts: 0 })

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
        expect(result).toMatchObject({ imported: 0, updated: 1, conflicts: 2, errors: [], skipped: [], sharedEmailContacts: 0 })

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
        expect(result).toMatchObject({ imported: 0, updated: 3, conflicts: 0, errors: [], skipped: [], sharedEmailContacts: 0 })
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

      test('the key is the E.164 number plus the extension, so extensions never collapse into the main number', () => {
        const main = '+12125550100'
        expect(normalizePhone('+1 212-555-0100')).toBe(main)
        expect(normalizePhone('+1 212-555-0100 ext. 5')).toBe(`${main};ext=5`)
        expect(normalizePhone('+1 212-555-0100 ext. 5')).not.toBe(normalizePhone('+1 212-555-0100 ext. 6'))
        expect(normalizePhone('+1 212-555-0100 ext. 5')).not.toBe(normalizePhone('+1 212-555-0100'))
        expect(normalizePhone('+1 212-555-0100 ext. 5')).not.toBe(main)

        // The same extension in every common spelling is one key.
        const spellings = [
          '+1 212-555-0100 x5',
          '+1 212-555-0100 x 5',
          '+1 212-555-0100;ext=5',
          '+1 212-555-0100 ;ext=5',
          '+1 212-555-0100 ext 5',
          '+1 212-555-0100 ext. 5',
          '(212) 555-0100 EXT. 5',
          '212.555.0100 extension 5',
          '2125550100,x5',
        ]
        for (const spelling of spellings) expect(normalizePhone(spelling)).toBe(`${main};ext=5`)

        // Bare numbers still equal each other however they are written.
        expect(normalizePhone('2125550100')).toBe(main)
        expect(normalizePhone('+12125550100')).toBe(main)
        expect(normalizePhone('(212) 555-0100')).toBe(main)
        expect(normalizePhone('212/555/0100')).toBe(main)
      })

      test('text around a number makes it prose, never a key', () => {
        for (const prose of [
          'Call me at +1 (212) 555-0100',
          'ask for Pat 212-555-0100',
          '212-555-0100 (home)',
          '212-555-0100 or 212-555-0101',
          'tel:+12125550100',
          '+1 212-555-0100 ext. five',
          '+1 212-555-0100 ext. 5 after hours',
        ]) {
          expect(normalizePhone(prose)).toBeNull()
        }
      })

      test('ext 5, ext 6, and no extension are three different people at one main number', async () => {
        const user = await fresh('extensions')
        try {
          const bare = await seedLocal(user, { display_name: 'Main Line' }, { phones: ['+1 212-555-0100'] })
          const ext5 = await seedLocal(user, { display_name: 'Desk Five' }, { phones: ['+1 212-555-0100 ext. 5'] })

          const result = await reconcileGoogleContacts(user.db, user.id, [
            { resourceName: 'people/e6', names: [{ displayName: 'Desk Six' }], phoneNumbers: [{ value: '212-555-0100 x6' }] },
            { resourceName: 'people/e5', names: [{ displayName: 'Desk Five' }], phoneNumbers: [{ value: '(212) 555-0100;ext=5' }] },
            { resourceName: 'people/e0', names: [{ displayName: 'Main Line' }], phoneNumbers: [{ value: '2125550100' }] },
          ])
          expect(result).toMatchObject({ imported: 1, updated: 2, skipped: [], errors: [] })
          expect((await getContact(user.db, ext5))!.platform_links.map((l) => l.platform_id)).toEqual(['people/e5'])
          expect((await getContact(user.db, bare))!.platform_links.map((l) => l.platform_id)).toEqual(['people/e0'])
          const six = (await listContacts(user.db)).find((c) => c.display_name === 'Desk Six')!
          expect(six.platform_links.map((l) => l.platform_id)).toEqual(['people/e6'])
          expect(await listContacts(user.db)).toHaveLength(3)
        } finally {
          await user.db.close()
        }
      })

      test('a phone buried in prose never matches the contact that has the number', async () => {
        const user = await fresh('prose')
        try {
          const id = await seedLocal(user, { display_name: 'Real Number' }, { phones: ['+1 212-555-0100'] })
          const result = await reconcileGoogleContacts(user.db, user.id, [
            { resourceName: 'people/prose', names: [{ displayName: 'Someone Else' }], phoneNumbers: [{ value: 'Call me at +1 (212) 555-0100' }] },
          ])
          expect(result).toMatchObject({ imported: 1, updated: 0, skipped: [] })
          expect((await getContact(user.db, id))!.platform_links).toEqual([])
        } finally {
          await user.db.close()
        }
      })

      test("Google's canonical form decides the region; the extension still comes from the raw value", () => {
        const bare = '2125550100'
        const mexico = ['+52', bare].join('')
        expect(phoneKey(bare)).toBe('+12125550100')
        expect(phoneKey(bare, mexico)).toBe(mexico)
        expect(phoneKey(`${bare} x5`, mexico)).toBe(`${mexico};ext=5`)
        expect(phoneKey(`${bare} ext. 5`, mexico)).toBe(phoneKey(`${bare};ext=5`, mexico))
        // Unusable canonical forms fall back to parsing the raw value.
        expect(phoneKey('(212) 555-0100', '')).toBe('+12125550100')
        expect(phoneKey('(212) 555-0100', null)).toBe('+12125550100')
        expect(phoneKey('(212) 555-0100', 'not a number')).toBe('+12125550100')
        expect(phoneKey('(212) 555-0100', '2125550100')).toBe('+12125550100')
        // Prose with no canonical form is still not a key.
        expect(phoneKey('Call me at 212-555-0100')).toBeNull()
      })

      test('a canonical form never rescues a value normalizePhone would refuse as text', () => {
        const canonical = '+12125550100'
        for (const raw of [
          '212-555-0100,,123',
          '212-555-0100#123',
          '212-555-0100;5',
          '212-555-0100 extn 5',
          '212-555-0100 ext=5',
          '212-555-0100 ext. five',
          'Call Pat at 212-555-0100',
          '212-555-0100 (home)',
          'tel:+12125550100',
          '',
        ]) {
          expect(normalizePhone(raw)).toBeNull()
          expect(phoneKey(raw, canonical)).toBeNull()
        }
        // The recognised spellings still work, with the canonical form.
        expect(phoneKey('212-555-0100 x123', canonical)).toBe(`${canonical};ext=123`)
        expect(phoneKey('212-555-0100;ext=123', canonical)).toBe(`${canonical};ext=123`)
        expect(phoneKey('212-555-0100 ext. 123', canonical)).toBe(`${canonical};ext=123`)
      })

      test('the raw number, read in the canonical form\'s country, must be that very number', () => {
        const national = ['551', '234', '5678'].join('')
        const bare = ['551', '234', '5678'].join(' ')
        const mexico = ['+52', national].join('')
        const us = ['+1', national].join('')
        expect(phoneKey('55 1234 5678', mexico)).toBe(mexico)
        expect(phoneKey(['+52', '55 1234 5678'].join(' '), mexico)).toBe(mexico)
        expect(phoneKey(bare, us)).toBe(us)
        // A different number than the canonical form describes.
        expect(phoneKey('55 1234 5679', mexico)).toBeNull()
        expect(phoneKey('212-555-0100', '+12125550101')).toBeNull()
        // The raw value names another country than the canonical form.
        expect(phoneKey(['+1', bare].join(' '), mexico)).toBeNull()
        expect(phoneKey(['+52', '55 1234 5678'].join(' '), us)).toBeNull()
        // Digits that only agree after discarding leading digits are not "equal".
        expect(phoneKey(['99', '55 1234 5678'].join(''), mexico)).toBeNull()
      })

      test('a canonical form we cannot validate is only a fallback to the US reading when its country is code 1', () => {
        const unvalidatable = ['+52', '123'].join('')
        // The provider said "Mexico" but we cannot confirm it: no US guess.
        expect(phoneKey('(212) 555-0100', unvalidatable)).toBeNull()
        expect(phoneKey('(212) 555-0100', ['+44', '12'].join(''))).toBeNull()
        expect(phoneKey('(212) 555-0100', '+abc')).toBeNull()
        expect(phoneKey('(212) 555-0100 x5', unvalidatable)).toBeNull()
        // Code 1 is the US/NANP, so the US reading is the right one.
        expect(phoneKey('(212) 555-0100', ['+1', '123'].join(''))).toBe('+12125550100')
        expect(phoneKey('(212) 555-0100 x5', ['+1', '123'].join(''))).toBe('+12125550100;ext=5')
        // Saying nothing is not the same as saying something unverifiable.
        expect(phoneKey('(212) 555-0100')).toBe('+12125550100')
        expect(phoneKey('(212) 555-0100', null)).toBe('+12125550100')
        expect(phoneKey('(212) 555-0100', '')).toBe('+12125550100')
        expect(phoneKey('(212) 555-0100', '   ')).toBe('+12125550100')
        // Without a plus it is not an international canonical form at all.
        expect(phoneKey('(212) 555-0100', 'not a number')).toBe('+12125550100')
      })

      test('a bare Mexican national number with an MX canonical form does not match a US contact', async () => {
        const user = await fresh('mexico')
        try {
          const us = await seedLocal(user, { display_name: 'US Contact' }, { phones: ['(212) 555-0100'] })
          const bare = '2125550100'
          const person = (resourceName: string, canonicalForm?: string): Person => ({
            resourceName,
            names: [{ displayName: `Person ${resourceName}` }],
            phoneNumbers: [{ value: bare, canonicalForm }],
          })

          const mexican = await reconcileGoogleContacts(user.db, user.id, [person('people/mx', ['+52', bare].join(''))])
          expect(mexican).toMatchObject({ imported: 1, updated: 0, skipped: [] })
          expect((await getContact(user.db, us))!.platform_links).toEqual([])

          // The Mexican contact stored its own key, so a US-canonical person
          // with the same digits reaches only the US contact.
          const american = await reconcileGoogleContacts(user.db, user.id, [person('people/us', ['+1', bare].join(''))])
          expect(american).toMatchObject({ imported: 0, updated: 1, skipped: [] })
          expect((await getContact(user.db, us))!.platform_links.map((l) => l.platform_id)).toEqual(['people/us'])

          // Re-running the Mexican one still finds its own contact by id.
          const again = await reconcileGoogleContacts(user.db, user.id, [person('people/mx', ['+52', bare].join(''))])
          expect(again).toMatchObject({ imported: 0, updated: 1 })
          expect(await listContacts(user.db)).toHaveLength(2)
        } finally {
          await user.db.close()
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
          expect(result).toMatchObject({ imported: 2, updated: 0, conflicts: 2, errors: [], skipped: [], sharedEmailContacts: 2 })

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
          expect(again).toMatchObject({ imported: 0, updated: 2, conflicts: 0, errors: [], skipped: [], sharedEmailContacts: 0 })
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

      test('a Google id linked to one contact whose email belongs to another is skipped, not merged', async () => {
        const user = await fresh('trust')
        try {
          const owner = await seedLocal(user, { display_name: 'Linked Owner' }, { emails: ['owner@example.com'], googleId: 'people/trusted' })
          const other = await seedLocal(user, { display_name: 'Someone Else', company: 'Keep Me' }, { emails: ['other@example.com'] })
          const result = await reconcileGoogleContacts(user.db, user.id, [
            { resourceName: 'people/trusted', names: [{ displayName: 'Linked Owner' }], emailAddresses: [{ value: 'other@example.com' }], organizations: [{ name: 'New Co' }] },
          ])
          expect(result).toMatchObject({ imported: 0, updated: 0, conflicts: 0, errors: [] })
          expect(result.skipped).toEqual([expect.stringContaining('linked to one contact but its email or phone match a different contact')])
          expect(await getContact(user.db, owner)).toMatchObject({ company: null })
          expect(await getContact(user.db, other)).toMatchObject({ company: 'Keep Me', platform_links: [] })
        } finally {
          await user.db.close()
        }
      })

      test('a contact reached by its own link and by another stable-id card in the same batch: only the link-holder keeps it', async () => {
        const user = await fresh('linkclaim')
        try {
          const id = await seedLocal(
            user,
            { display_name: 'Held' },
            { emails: ['held@example.com'], phones: ['(202) 555-0143'], googleId: 'people/holder' }
          )
          const result = await reconcileGoogleContacts(user.db, user.id, [
            { resourceName: 'people/holder', names: [{ displayName: 'Held' }], organizations: [{ name: 'Holder Co' }] },
            { resourceName: 'people/claimer', names: [{ displayName: 'Claimer' }], emailAddresses: [{ value: 'held@example.com' }], organizations: [{ name: 'Claimer Co' }] },
          ])
          expect(result).toMatchObject({ imported: 0, updated: 1, errors: [] })
          expect(result.skipped).toEqual([expect.stringContaining('people/claimer')])
          expect(result.skipped[0]).toContain('already linked to a different Google contact')
          const contact = (await getContact(user.db, id))!
          expect(contact).toMatchObject({ company: 'Holder Co' })
          expect(contact.platform_links.map((l) => l.platform_id)).toEqual(['people/holder'])
          expect(await listContacts(user.db)).toHaveLength(1)
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
          const { stale, release } = withHeldIdentityIndex(user.db)
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

      test('a provider id claimed mid-sync cancels the merge instead of touching the other contact', async () => {
        const user = await fresh('claimed')
        try {
          const target = await seedLocal(user, { display_name: 'Target' }, { emails: ['target@example.com'] })
          const { stale, release } = withHeldIdentityIndex(user.db)

          const merging = reconcileGoogleContacts(stale, user.id, [
            {
              resourceName: 'people/contested',
              names: [{ displayName: 'Target', givenName: 'Tara' }],
              emailAddresses: [{ value: 'target@example.com' }],
              organizations: [{ name: 'Would Be Filled' }],
            },
          ])
          await Bun.sleep(100)
          // Meanwhile another contact takes that Google id.
          const rival = await seedLocal(user, { display_name: 'Rival' }, { googleId: 'people/contested' })
          const [before] = await user.db.query('SELECT last_synced_at FROM platform_link').collect<[{ last_synced_at: unknown }[]]>()
          release()
          const result = await merging

          expect(result).toMatchObject({ imported: 0, updated: 0, errors: [] })
          expect(result.skipped).toEqual([expect.stringContaining('linked to another contact while this import was running')])

          // Cancelled as a whole: no fills, no link on the target, and the
          // rival's link row was not touched by the clashing upsert.
          expect(await getContact(user.db, target)).toMatchObject({ company: null, first_name: null, platform_links: [] })
          const [after] = await user.db.query('SELECT last_synced_at FROM platform_link').collect<[{ last_synced_at: unknown }[]]>()
          expect(after).toEqual(before)
          expect((await getContact(user.db, rival))!.platform_links.map((l) => l.platform_id)).toEqual(['people/contested'])
        } finally {
          await user.db.close()
        }
      })

      test('conflicts are filed once: a unique index backs the check, and racing writers file one row', async () => {
        const user = await fresh('conflictonce')
        try {
          const id = await seedLocal(user, { display_name: 'Pat', company: 'Local Co' }, { emails: ['pat-once@example.com'] })
          const entry = { field: 'shared_email', value_a: 'pat-once@example.com', value_b: 'Also on other Google contacts', source_a: 'google', source_b: 'google' }

          await expect(
            user.db
              .query('CREATE conflict CONTENT { owner: $owner, contact: $contact, field: "x", value_a: "a", value_b: "b" }', {
                owner: user.id,
                contact: new RecordId('contact', id),
              })
              .collect()
          ).resolves.toBeDefined()
          await expect(
            user.db
              .query('CREATE conflict CONTENT { owner: $owner, contact: $contact, field: "x", value_a: "a", value_b: "b" }', {
                owner: user.id,
                contact: new RecordId('contact', id),
              })
              .collect()
          ).rejects.toThrow(/conflict_unique_disagreement/)

          const added = await Promise.all(Array.from({ length: 6 }, () => fileConflictsOnce(user.db, user.id, id, [entry])))
          expect(added.reduce((sum, n) => sum + n, 0)).toBe(1)
          const [rows] = await user.db.query("SELECT id FROM conflict WHERE field = 'shared_email'").collect<[unknown[]]>()
          expect(rows).toHaveLength(1)

          // Merges racing each other file the same disagreement once too.
          const person: Person = { resourceName: 'people/pat', names: [{ displayName: 'Pat' }], emailAddresses: [{ value: 'pat-once@example.com' }], organizations: [{ name: 'Remote Co' }] }
          const runs = await Promise.all(Array.from({ length: 4 }, () => reconcileGoogleContacts(user.db, user.id, [person])))
          for (const run of runs) expect(run.errors).toEqual([])
          const [company] = await user.db.query("SELECT id FROM conflict WHERE field = 'company'").collect<[unknown[]]>()
          expect(company).toHaveLength(1)
        } finally {
          await user.db.close()
        }
      })

      test('a link for one provider id resolves to its contact with a single lookup, per user', async () => {
        const user = await fresh('lookup')
        const other = await fresh('lookup-other')
        try {
          const id = await seedLocal(user, { display_name: 'Findable' }, { googleId: 'people/find' })
          expect(await findContactByLink(user.db, 'google', 'people/find')).toBe(id)
          expect(await findContactByLink(user.db, 'icloud', 'people/find')).toBeNull()
          expect(await findContactByLink(user.db, 'google', 'people/missing')).toBeNull()
          expect(await findContactByLink(other.db, 'google', 'people/find')).toBeNull()
        } finally {
          await user.db.close()
          await other.db.close()
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
        expect(result).toMatchObject({ imported: 2, updated: 0, conflicts: 0, errors: [], skipped: [], sharedEmailContacts: 0 })
        expect(await listContacts(carol.db)).toHaveLength(2)
      } finally {
        await carol.db.close()
      }
    })
  })

  describe('vCard import', () => {
    const fresh = async (label: string) => createTestUser(database, label)
    const card = (body: string) => vcard(body)
    const withUid = (uid: string, body: string) => vcard(`UID:${uid}\r\n${body}`)
    const linksOf = async (user: TestUser) => {
      const [rows] = await user.db
        .query("SELECT platform_id FROM platform_link WHERE platform = 'icloud'")
        .collect<[{ platform_id: string }[]]>()
      return rows.map((row) => row.platform_id)
    }

    test('imports cards, extracting names, emails, phones, and organization', async () => {
      const dave = await fresh('dave')
      try {
        const outcome = await importVcf(
          dave.db,
          dave.id,
          card('FN:Lena Park\r\nN:Park;Lena;;;\r\nEMAIL;TYPE=WORK:lena@example.com\r\nTEL;TYPE=CELL:+1 202 555 0150\r\nORG:Example Lab\r\nTITLE:Engineer')
        )
        expect(outcome).toMatchObject({ imported: 1, updated: 0, errors: [], skipped: [], total: 1 })

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
        // No UID on the card, so no link is stored for a throwaway id.
        expect(contact.platform_links).toEqual([])
      } finally {
        await dave.db.close()
      }
    })

    test('imports the repository synthetic fixture (LF line endings)', async () => {
      const frank = await fresh('frank')
      try {
        const fixture = await Bun.file(new URL('../../examples/synthetic/maya-chen.vcf', import.meta.url)).text()
        const outcome = await importVcf(frank.db, frank.id, fixture)
        expect(outcome).toMatchObject({ imported: 1, errors: [], skipped: [] })
        const [contact] = await listContacts(frank.db)
        expect(contact).toMatchObject({ first_name: 'Maya', last_name: 'Chen', display_name: 'Maya Chen' })
        expect(contact.emails[0].email).toBe('maya.chen@example.com')
        // The fixture's UID is the link's platform id.
        expect(contact.platform_links[0].platform_id).toBe('synthetic-icloud-maya-chen-001')
      } finally {
        await frank.db.close()
      }
    })

    test('re-importing a file with UIDs updates in place and creates nothing new', async () => {
      const user = await fresh('uid')
      try {
        const file =
          withUid('uid-ivo', 'FN:Ivo One\r\nEMAIL:ivo@example.com') +
          withUid('uid-ada', 'FN:Ada Two\r\nTEL:+1 202 555 0151')
        const first = await importVcf(user.db, user.id, file)
        expect(first).toMatchObject({ imported: 2, updated: 0, skipped: [], conflicts: 0 })
        const again = await importVcf(user.db, user.id, file)
        expect(again).toMatchObject({ imported: 0, updated: 2, skipped: [], conflicts: 0, errors: [] })
        expect(await listContacts(user.db)).toHaveLength(2)
        expect((await linksOf(user)).sort()).toEqual(['uid-ada', 'uid-ivo'])

        // The UID still finds the contact when the card's email has changed.
        const moved = withUid('uid-ivo', 'FN:Ivo One\r\nEMAIL:ivo.new@example.com')
        expect(await importVcf(user.db, user.id, moved)).toMatchObject({ imported: 0, updated: 1 })
        expect(await listContacts(user.db)).toHaveLength(2)
      } finally {
        await user.db.close()
      }
    })

    test('a phone-only card without a UID is recognised by its exact phone on re-import', async () => {
      const user = await fresh('phoneonly')
      try {
        const file = card('FN:Pat Phone\r\nTEL:+1 202 555 0152')
        expect(await importVcf(user.db, user.id, file)).toMatchObject({ imported: 1, updated: 0 })
        const again = await importVcf(user.db, user.id, file)
        expect(again).toMatchObject({ imported: 0, updated: 1, skipped: [], errors: [] })
        expect(await listContacts(user.db)).toHaveLength(1)
        // A throwaway id is never stored as a link.
        expect(await linksOf(user)).toEqual([])
      } finally {
        await user.db.close()
      }
    })

    test('a no-UID import stores no link, so a later import with real UIDs links the same person by email or phone', async () => {
      const user = await fresh('upgrade')
      try {
        const first = await importVcf(
          user.db,
          user.id,
          card('FN:Ivo One\r\nEMAIL:ivo-up@example.com') + card('FN:Pat Phone\r\nTEL:+1 212 555 0101')
        )
        expect(first).toMatchObject({ imported: 2, skipped: [] })
        expect(await linksOf(user)).toEqual([])

        const later = await importVcf(
          user.db,
          user.id,
          withUid('uid-ivo', 'FN:Ivo One\r\nEMAIL:IVO-UP@example.com') + withUid('uid-pat', 'FN:Pat Phone\r\nTEL:(212) 555-0101')
        )
        expect(later).toMatchObject({ imported: 0, updated: 2, skipped: [], errors: [] })
        expect(await listContacts(user.db)).toHaveLength(2)
        expect((await linksOf(user)).sort()).toEqual(['uid-ivo', 'uid-pat'])

        // And from then on the UID is the identity.
        const third = await importVcf(user.db, user.id, withUid('uid-ivo', 'FN:Ivo One\r\nEMAIL:moved@example.com'))
        expect(third).toMatchObject({ imported: 0, updated: 1 })
        expect(await listContacts(user.db)).toHaveLength(2)
      } finally {
        await user.db.close()
      }
    })

    test('a UID-less card reaching a contact that a UID card holds in the same file is skipped', async () => {
      const user = await fresh('uidless-claim')
      try {
        const id = await seedLocal(user, { display_name: 'Anchor' }, { emails: ['anchor@example.com'] })
        await importVcf(user.db, user.id, withUid('uid-anchor', 'FN:Anchor\r\nEMAIL:anchor@example.com'))
        const outcome = await importVcf(
          user.db,
          user.id,
          withUid('uid-anchor', 'FN:Anchor\r\nORG:Anchor Co') + card('FN:No Uid\r\nEMAIL:anchor@example.com')
        )
        expect(outcome).toMatchObject({ imported: 0, updated: 1, errors: [] })
        expect(outcome.skipped).toEqual([expect.stringContaining('already linked to a different iCloud contact')])
        expect((await getContact(user.db, id))!.platform_links.map((l) => l.platform_id)).toEqual(['uid-anchor'])
        expect(await listContacts(user.db)).toHaveLength(1)
      } finally {
        await user.db.close()
      }
    })

    test('a UID linked to one contact whose email belongs to another is skipped as ambiguous', async () => {
      const user = await fresh('uidtrust')
      try {
        const owner = await seedLocal(user, { display_name: 'Card Owner' }, { emails: ['card-owner@example.com'] })
        await importVcf(user.db, user.id, withUid('uid-owner', 'FN:Card Owner\r\nEMAIL:card-owner@example.com'))
        const other = await seedLocal(user, { display_name: 'Other Person', company: 'Keep Me' }, { phones: ['(212) 555-0102'] })

        const outcome = await importVcf(
          user.db,
          user.id,
          withUid('uid-owner', 'FN:Card Owner\r\nTEL:+1 212 555 0102\r\nORG:Overwrite Co')
        )
        expect(outcome).toMatchObject({ imported: 0, updated: 0, conflicts: 0, errors: [] })
        expect(outcome.skipped).toEqual([expect.stringContaining('linked to one contact but its email or phone match a different contact')])
        expect(await getContact(user.db, owner)).toMatchObject({ company: null })
        expect(await getContact(user.db, other)).toMatchObject({ company: 'Keep Me', platform_links: [] })
      } finally {
        await user.db.close()
      }
    })

    test('a phone that is not a valid number is never a match key, and names never are', async () => {
      const user = await fresh('weakkeys')
      try {
        await seedLocal(user, { display_name: 'Same Name' }, { phones: ['555-0143'] })
        const outcome = await importVcf(
          user.db,
          user.id,
          card('FN:Same Name\r\nTEL:555-0143') + card('FN:Same Name\r\nN:Name;Same;;;')
        )
        // The first card carries the exact (unkeyable) text a local contact
        // already has, so it cannot be told apart from an earlier import. The
        // second shares nothing with anyone: names are never a key.
        expect(outcome).toMatchObject({ imported: 1, updated: 0 })
        expect(outcome.skipped).toEqual([expect.stringContaining("can't be told apart from an earlier import")])
        expect(await listContacts(user.db)).toHaveLength(2)
      } finally {
        await user.db.close()
      }
    })

    test('a match fills empty fields, files conflicts for differences, and never overwrites or reclassifies', async () => {
      const user = await fresh('icloudmerge')
      try {
        const id = await seedLocal(
          user,
          { display_name: 'Maya C.', first_name: 'Maya', company: 'Local Studio', is_financial_advisor: true },
          { emails: ['maya@example.com'] }
        )
        const outcome = await importVcf(
          user.db,
          user.id,
          withUid('uid-maya', 'FN:Maya Chen\r\nN:Chen;Maya;;;\r\nEMAIL:MAYA@example.com\r\nORG:Apple Studio\r\nTITLE:Designer')
        )
        expect(outcome).toMatchObject({ imported: 0, updated: 1, filledFields: 2, conflicts: 2, skipped: [], errors: [] })

        const contact = (await getContact(user.db, id))!
        expect(contact).toMatchObject({
          first_name: 'Maya',
          last_name: 'Chen',
          job_title: 'Designer',
          display_name: 'Maya C.',
          company: 'Local Studio',
          is_financial_advisor: true,
        })
        expect(contact.platform_links.map((l) => l.platform_id)).toEqual(['uid-maya'])
        const [conflicts] = await user.db
          .query('SELECT field, value_a, value_b, source_a, source_b FROM conflict ORDER BY field')
          .collect<[Record<string, unknown>[]]>()
        expect(conflicts).toEqual([
          { field: 'company', value_a: 'Local Studio', value_b: 'Apple Studio', source_a: 'local', source_b: 'icloud' },
          { field: 'display_name', value_a: 'Maya C.', value_b: 'Maya Chen', source_a: 'local', source_b: 'icloud' },
        ])
      } finally {
        await user.db.close()
      }
    })

    test('a family email shared by two cards is not a match key: each card is its own contact, flagged for review', async () => {
      const user = await fresh('family')
      try {
        const local = await seedLocal(user, { display_name: 'Household', company: 'Home' }, { emails: ['family@example.com'] })
        const file =
          withUid('uid-mom', 'FN:Mom\r\nEMAIL:family@example.com') +
          withUid('uid-kid', 'FN:Kid\r\nEMAIL:FAMILY@example.com')
        const outcome = await importVcf(user.db, user.id, file)
        expect(outcome).toMatchObject({ imported: 2, updated: 0, skipped: [], sharedEmailContacts: 2, conflicts: 2 })

        const contacts = await listContacts(user.db)
        expect(contacts).toHaveLength(3)
        const mom = contacts.find((c) => c.display_name === 'Mom')!
        const kid = contacts.find((c) => c.display_name === 'Kid')!
        expect(mom.id).not.toBe(kid.id)
        expect((await getContact(user.db, local))!).toMatchObject({ company: 'Home', platform_links: [] })

        const [filed] = await user.db
          .query("SELECT contact, source_a FROM conflict WHERE field = 'shared_email'")
          .collect<[{ contact: { id: unknown }; source_a: string }[]]>()
        expect(new Set(filed.map((row) => String(row.contact.id)))).toEqual(new Set([mom.id, kid.id]))
        expect(filed.every((row) => row.source_a === 'icloud')).toBe(true)

        // Same file again: found by UID, nothing duplicated or re-filed.
        const again = await importVcf(user.db, user.id, file)
        expect(again).toMatchObject({ imported: 0, updated: 2, conflicts: 0 })
        expect(await listContacts(user.db)).toHaveLength(3)
      } finally {
        await user.db.close()
      }
    })

    test('a card whose identifiers match two different contacts is skipped and reported', async () => {
      const user = await fresh('twomatches')
      try {
        const a = await seedLocal(user, { display_name: 'Contact A' }, { emails: ['a@example.com'] })
        const b = await seedLocal(user, { display_name: 'Contact B' }, { phones: ['(202) 555-0143'] })
        const outcome = await importVcf(
          user.db,
          user.id,
          withUid('uid-both', 'FN:Both\r\nEMAIL:a@example.com\r\nTEL:+1 202 555 0143')
        )
        expect(outcome).toMatchObject({ imported: 0, updated: 0, errors: [] })
        expect(outcome.skipped).toEqual([expect.stringContaining('more than one existing contact')])
        expect((await getContact(user.db, a))!.platform_links).toEqual([])
        expect((await getContact(user.db, b))!.platform_links).toEqual([])
        expect(await listContacts(user.db)).toHaveLength(2)
      } finally {
        await user.db.close()
      }
    })

    test('a contact already linked to a different iCloud UID is not relinked', async () => {
      const user = await fresh('relinkicloud')
      try {
        const id = await seedLocal(user, { display_name: 'Linked' }, { emails: ['linked@example.com'] })
        await user.db
          .query('CREATE platform_link CONTENT { owner: $owner, contact: $contact, platform: "icloud", platform_id: "uid-original" }', {
            owner: user.id,
            contact: new RecordId('contact', id),
          })
          .collect()
        const outcome = await importVcf(user.db, user.id, withUid('uid-other', 'FN:Linked\r\nEMAIL:linked@example.com'))
        expect(outcome).toMatchObject({ imported: 0, updated: 0 })
        expect(outcome.skipped).toEqual([expect.stringContaining('already linked to a different iCloud contact')])
        expect((await getContact(user.db, id))!.platform_links.map((l) => l.platform_id)).toEqual(['uid-original'])
      } finally {
        await user.db.close()
      }
    })

    test('two cards in one file claiming the same contact are both skipped; a repeated UID is reported', async () => {
      const user = await fresh('claimsicloud')
      try {
        const id = await seedLocal(user, { display_name: 'Contested' }, { emails: ['contested@example.com'], phones: ['(202) 555-0143'] })
        const claims = await importVcf(
          user.db,
          user.id,
          withUid('uid-1', 'FN:By Email\r\nEMAIL:contested@example.com') + withUid('uid-2', 'FN:By Phone\r\nTEL:+1 202 555 0143')
        )
        expect(claims).toMatchObject({ imported: 0, updated: 0 })
        expect(claims.skipped).toHaveLength(2)
        expect((await getContact(user.db, id))!.platform_links).toEqual([])

        const repeated = await importVcf(
          user.db,
          user.id,
          withUid('uid-rep', 'FN:First Copy\r\nEMAIL:rep1@example.com') + withUid('uid-rep', 'FN:Second Copy\r\nEMAIL:rep2@example.com')
        )
        expect(repeated).toMatchObject({ imported: 1 })
        expect(repeated.skipped).toEqual([expect.stringContaining('same id appears more than once')])
      } finally {
        await user.db.close()
      }
    })

    test('every card is accounted for: created, matched, or reported as skipped or errored', async () => {
      const user = await fresh('accounted')
      try {
        await seedLocal(user, { display_name: 'Existing' }, { emails: ['existing@example.com'] })
        await seedLocal(user, { display_name: 'Dup One' }, { emails: ['dup@example.com'] })
        await seedLocal(user, { display_name: 'Dup Two' }, { emails: ['dup@example.com'] })
        const file =
          withUid('u1', 'FN:New Person\r\nEMAIL:new@example.com') +
          withUid('u2', 'FN:Existing\r\nEMAIL:existing@example.com') +
          withUid('u3', 'FN:Ambiguous\r\nEMAIL:dup@example.com') +
          withUid('u4', 'FN:Nothing But A Name')
        const outcome = await importVcf(user.db, user.id, file)
        expect(outcome.total).toBe(4)
        expect(outcome.imported + outcome.updated + outcome.skipped.length + outcome.errors.length).toBe(4)
        expect(outcome).toMatchObject({ imported: 2, updated: 1 })
        expect(outcome.skipped).toHaveLength(1)
      } finally {
        await user.db.close()
      }
    })

    describe('phones are stored and matched as written', () => {
      const phonesOf = async (user: TestUser, id: string) => (await getContact(user.db, id))!.phones.map((p) => p.phone)

      test('"NNN-NNNN xNNN" is not stripped into another person\'s ten-digit number', async () => {
        const user = await fresh('stripped')
        try {
          const local = await seedLocal(user, { display_name: 'Local Owner' }, { phones: ['(212) 555-0123'] })
          // Stripping the extension marker would turn this into 2125550123.
          const outcome = await importVcf(user.db, user.id, card('FN:Different Person\r\nTEL:212-5550 x123'))
          expect(outcome).toMatchObject({ imported: 1, updated: 0, skipped: [], conflicts: 0 })
          const contacts = await listContacts(user.db)
          expect(contacts).toHaveLength(2)
          expect(await phonesOf(user, local)).toEqual(['(212) 555-0123'])
          // The raw value is stored, not a mangled one.
          const created = contacts.find((c) => c.display_name === 'Different Person')!
          expect(created.phones.map((p) => p.phone)).toEqual(['212-5550 x123'])
        } finally {
          await user.db.close()
        }
      })

      test('a value with prose around a number is stored as written and is not a key', async () => {
        const user = await fresh('prosecard')
        try {
          const local = await seedLocal(user, { display_name: 'Local Owner' }, { phones: ['(212) 555-0123'] })
          const outcome = await importVcf(user.db, user.id, card('FN:Office Contact\r\nTEL:Office: 212-555-0123'))
          expect(outcome).toMatchObject({ imported: 1, updated: 0, skipped: [] })
          expect(await listContacts(user.db)).toHaveLength(2)
          expect((await getContact(user.db, local))!.platform_links).toEqual([])
          const created = (await listContacts(user.db)).find((c) => c.display_name === 'Office Contact')!
          expect(created.phones.map((p) => p.phone)).toEqual(['Office: 212-555-0123'])
        } finally {
          await user.db.close()
        }
      })

      test('a tel: URI with ;ext= matches only the same extension, and the same extension in another spelling', async () => {
        const user = await fresh('teluri')
        try {
          const bare = await seedLocal(user, { display_name: 'Main Line' }, { phones: ['(212) 555-0100'] })
          const ext5 = await seedLocal(user, { display_name: 'Desk Five' }, { phones: ['212-555-0100 x5'] })
          const ext6 = await seedLocal(user, { display_name: 'Desk Six' }, { phones: ['+1 212 555 0100 ext. 6'] })

          const outcome = await importVcf(
            user.db,
            user.id,
            card('FN:Desk Five\r\nTEL;VALUE=uri:tel:+1-212-555-0100;ext=5')
          )
          expect(outcome).toMatchObject({ imported: 0, updated: 1, skipped: [], errors: [] })
          expect(await listContacts(user.db)).toHaveLength(3)
          // The raw value (tel: removed) was not used to overwrite anything.
          expect(await phonesOf(user, ext5)).toEqual(['212-555-0100 x5'])
          expect(await phonesOf(user, bare)).toEqual(['(212) 555-0100'])
          expect(await phonesOf(user, ext6)).toEqual(['+1 212 555 0100 ext. 6'])

          // Another spelling of extension 6 matches the extension-6 contact only.
          const other = await importVcf(user.db, user.id, card('FN:Desk Six\r\nTEL:212.555.0100 EXT 6'))
          expect(other).toMatchObject({ imported: 0, updated: 1, skipped: [] })
          expect(await listContacts(user.db)).toHaveLength(3)
        } finally {
          await user.db.close()
        }
      })

      test('an extension never matches the bare main number, and a bare number never matches an extension', async () => {
        const user = await fresh('extvsbare')
        try {
          await seedLocal(user, { display_name: 'Main Line' }, { phones: ['(212) 555-0100'] })
          const withExt = await importVcf(user.db, user.id, card('FN:Extension Person\r\nTEL:212-555-0100 x201'))
          expect(withExt).toMatchObject({ imported: 1, updated: 0 })
          const user2 = await fresh('bareafterext')
          try {
            await seedLocal(user2, { display_name: 'Desk' }, { phones: ['212-555-0100 x201'] })
            const bare = await importVcf(user2.db, user2.id, card('FN:Main Person\r\nTEL:(212) 555-0100'))
            expect(bare).toMatchObject({ imported: 1, updated: 0 })
          } finally {
            await user2.db.close()
          }
        } finally {
          await user.db.close()
        }
      })

      test('vCard escapes in a phone value are undone before it is read', async () => {
        const user = await fresh('escapes')
        try {
          const local = await seedLocal(user, { display_name: 'Escaped' }, { phones: ['212-555-0100 x5'] })
          const outcome = await importVcf(user.db, user.id, card('FN:Escaped\r\nTEL:+1 212 555 0100\\;ext=5'))
          expect(outcome).toMatchObject({ imported: 0, updated: 1, skipped: [] })
          expect(await phonesOf(user, local)).toEqual(['212-555-0100 x5'])
        } finally {
          await user.db.close()
        }
      })
    })

    describe('cards without a UID do not multiply on re-import', () => {
      test('the same UID-less pair sharing an email, synced three times, ends with exactly two contacts', async () => {
        const user = await fresh('triple')
        try {
          const file = card('FN:Mom\r\nEMAIL:family@example.com') + card('FN:Kid\r\nEMAIL:family@example.com')
          const first = await importVcf(user.db, user.id, file)
          expect(first).toMatchObject({ imported: 2, skipped: [], sharedEmailContacts: 2 })
          for (const run of [2, 3]) {
            const again = await importVcf(user.db, user.id, file)
            expect(again).toMatchObject({ imported: 0, updated: 0, errors: [] })
            expect(again.skipped).toHaveLength(2)
            for (const message of again.skipped) {
              expect(message).toContain("can't be told apart from an earlier import; not re-imported")
            }
            expect(await listContacts(user.db)).toHaveLength(2)
            expect(run).toBeGreaterThan(1)
          }
          const [filed] = await user.db.query("SELECT id FROM conflict WHERE field = 'shared_email'").collect<[unknown[]]>()
          expect(filed).toHaveLength(2)
        } finally {
          await user.db.close()
        }
      })

      test('a shared value already carried by a local contact keeps UID-less cards from being created', async () => {
        const user = await fresh('carried')
        try {
          await seedLocal(user, { display_name: 'Household' }, { emails: ['house@example.com'] })
          const outcome = await importVcf(
            user.db,
            user.id,
            card('FN:Mom\r\nEMAIL:house@example.com') + card('FN:Kid\r\nEMAIL:HOUSE@example.com')
          )
          expect(outcome).toMatchObject({ imported: 0, updated: 0 })
          expect(outcome.skipped).toHaveLength(2)
          expect(await listContacts(user.db)).toHaveLength(1)
        } finally {
          await user.db.close()
        }
      })

      test('a card with no email and no keyable phone is created once, then skipped while its values are on a contact', async () => {
        const user = await fresh('novalues')
        try {
          const file = card('FN:Front Desk\r\nTEL:Office: 212-555-0123')
          expect(await importVcf(user.db, user.id, file)).toMatchObject({ imported: 1, skipped: [] })
          for (let run = 0; run < 2; run += 1) {
            const again = await importVcf(user.db, user.id, file)
            expect(again).toMatchObject({ imported: 0, updated: 0 })
            expect(again.skipped).toEqual([expect.stringContaining("can't be told apart from an earlier import")])
          }
          expect(await listContacts(user.db)).toHaveLength(1)
        } finally {
          await user.db.close()
        }
      })

      test('a UID-less card with a unique key is unaffected: new when unknown, matched when known', async () => {
        const user = await fresh('keyed')
        try {
          const file = card('FN:Keyed\r\nEMAIL:keyed@example.com')
          expect(await importVcf(user.db, user.id, file)).toMatchObject({ imported: 1 })
          expect(await importVcf(user.db, user.id, file)).toMatchObject({ imported: 0, updated: 1, skipped: [] })
          expect(await listContacts(user.db)).toHaveLength(1)
        } finally {
          await user.db.close()
        }
      })
    })

    describe('a UID-less card cannot take a contact that already has a provider link', () => {
      test('it is skipped, not merged', async () => {
        const user = await fresh('linkedcontact')
        try {
          const id = await seedLocal(user, { display_name: 'Linked', company: 'Keep' }, { emails: ['linked-card@example.com'] })
          await importVcf(user.db, user.id, withUid('uid-linked', 'FN:Linked\r\nEMAIL:linked-card@example.com'))

          const outcome = await importVcf(user.db, user.id, card('FN:Fresh Export\r\nEMAIL:linked-card@example.com\r\nORG:Overwrite Co'))
          expect(outcome).toMatchObject({ imported: 0, updated: 0, conflicts: 0, errors: [] })
          expect(outcome.skipped).toEqual([expect.stringContaining('already linked to a different iCloud contact')])
          const contact = (await getContact(user.db, id))!
          expect(contact).toMatchObject({ company: 'Keep' })
          expect(contact.platform_links.map((l) => l.platform_id)).toEqual(['uid-linked'])
        } finally {
          await user.db.close()
        }
      })

      test('even when the linked card is itself skipped by the UID-conflict rule in the same batch', async () => {
        const user = await fresh('linkedskipped')
        try {
          const holder = await seedLocal(user, { display_name: 'Holder' }, { phones: ['(212) 555-0101'] })
          await importVcf(user.db, user.id, withUid('uid-holder', 'FN:Holder\r\nTEL:(212) 555-0101'))
          const rival = await seedLocal(user, { display_name: 'Rival' }, { emails: ['rival@example.com'] })

          const outcome = await importVcf(
            user.db,
            user.id,
            // Same UID as the holder, but an email that belongs to the rival: skipped.
            withUid('uid-holder', 'FN:Holder\r\nEMAIL:rival@example.com') +
              // No UID, reaching the holder by its exact phone: also skipped.
              card('FN:Holder Again\r\nTEL:+1 212 555 0101\r\nORG:Overwrite Co')
          )
          expect(outcome).toMatchObject({ imported: 0, updated: 0, conflicts: 0, errors: [] })
          expect(outcome.skipped).toHaveLength(2)
          expect(outcome.skipped.some((message) => message.includes('linked to one contact but its email or phone match a different contact'))).toBe(true)
          expect(outcome.skipped.some((message) => message.includes('already linked to a different iCloud contact'))).toBe(true)
          expect(await getContact(user.db, holder)).toMatchObject({ company: null })
          expect(await getContact(user.db, rival)).toMatchObject({ company: null, platform_links: [] })
          expect(await listContacts(user.db)).toHaveLength(2)
        } finally {
          await user.db.close()
        }
      })
    })

    test('rejects a file with no cards', async () => {
      await expect(importVcf(alice.db, alice.id, '')).rejects.toBeInstanceOf(EmptyVcfError)
    })
  })

  describe('stored phone keys', () => {
    const usNumber = () => ['551', '234', '5678'].join('-')
    const mexRaw = '55 1234 5678'
    const national = ['551', '234', '5678'].join('')
    const mexCanonical = () => ['+52', national].join('')
    const keysOf = async (user: TestUser) => {
      const [rows] = await user.db
        .query('SELECT phone, phone_key FROM phone ORDER BY phone')
        .collect<[{ phone: string; phone_key?: string | null }[]]>()
      return Object.fromEntries(rows.map((row) => [row.phone, row.phone_key]))
    }

    test('the key chosen at import time is stored next to the raw text', async () => {
      const user = await createTestUser(database, 'storedkeys')
      try {
        await reconcileGoogleContacts(user.db, user.id, [
          { resourceName: 'people/k1', names: [{ displayName: 'Mexico' }], phoneNumbers: [{ value: mexRaw, canonicalForm: mexCanonical() }] },
          { resourceName: 'people/k2', names: [{ displayName: 'US Ext' }], phoneNumbers: [{ value: '(212) 555-0100 x5' }] },
          { resourceName: 'people/k3', names: [{ displayName: 'Prose' }], phoneNumbers: [{ value: 'Call Pat at 212-555-0100' }] },
        ])
        await importVcf(user.db, user.id, vcard(`FN:Card\r\nTEL:${usNumber()}`))
        await seedLocal(user, { display_name: 'Manual' }, { phones: ['(202) 555-0143'] })

        expect(await keysOf(user)).toEqual({
          [mexRaw]: mexCanonical(),
          '(212) 555-0100 x5': '+12125550100;ext=5',
          'Call Pat at 212-555-0100': null,
          [usNumber()]: ['+1', national].join(''),
          '(202) 555-0143': '+12025550143',
        })
      } finally {
        await user.db.close()
      }
    })

    test('Google MX number then an iCloud US card with the same digits: different people', async () => {
      const user = await createTestUser(database, 'mx-then-us')
      try {
        const google = { resourceName: 'people/mx1', names: [{ displayName: 'Mexico City' }], phoneNumbers: [{ value: mexRaw, canonicalForm: mexCanonical() }] }
        expect(await reconcileGoogleContacts(user.db, user.id, [google])).toMatchObject({ imported: 1 })

        const card = vcard(`UID:uid-us\r\nFN:New Jersey\r\nTEL:${['+1', usNumber()].join(' ')}`)
        const outcome = await importVcf(user.db, user.id, card)
        expect(outcome).toMatchObject({ imported: 1, updated: 0, skipped: [], conflicts: 0, errors: [] })
        expect(await listContacts(user.db)).toHaveLength(2)

        // Re-syncing keeps the same keys and the same two contacts.
        const before = await keysOf(user)
        expect(await reconcileGoogleContacts(user.db, user.id, [google])).toMatchObject({ imported: 0, updated: 1, skipped: [] })
        expect(await importVcf(user.db, user.id, card)).toMatchObject({ imported: 0, updated: 1, skipped: [] })
        expect(await keysOf(user)).toEqual(before)
        expect(await listContacts(user.db)).toHaveLength(2)
      } finally {
        await user.db.close()
      }
    })

    test('iCloud US card then a Google MX person with the same digits: different people', async () => {
      const user = await createTestUser(database, 'us-then-mx')
      try {
        await importVcf(user.db, user.id, vcard(`UID:uid-us2\r\nFN:New Jersey\r\nTEL:${['+1', usNumber()].join(' ')}`))
        const outcome = await reconcileGoogleContacts(user.db, user.id, [
          { resourceName: 'people/mx2', names: [{ displayName: 'Mexico City' }], phoneNumbers: [{ value: mexRaw, canonicalForm: mexCanonical() }] },
        ])
        expect(outcome).toMatchObject({ imported: 1, updated: 0, skipped: [], conflicts: 0 })
        expect(await listContacts(user.db)).toHaveLength(2)
      } finally {
        await user.db.close()
      }
    })

    test('a Mexican contact matches the same Mexican number written with its country code', async () => {
      const user = await createTestUser(database, 'mx-match')
      try {
        const manual = await seedLocal(user, { display_name: 'Manual Mexico' }, { phones: [['+52', mexRaw].join(' ')] })
        const outcome = await reconcileGoogleContacts(user.db, user.id, [
          { resourceName: 'people/mx3', names: [{ displayName: 'Manual Mexico' }], phoneNumbers: [{ value: mexRaw, canonicalForm: mexCanonical() }] },
        ])
        expect(outcome).toMatchObject({ imported: 0, updated: 1, skipped: [] })
        expect((await getContact(user.db, manual))!.platform_links.map((l) => l.platform_id)).toEqual(['people/mx3'])
      } finally {
        await user.db.close()
      }
    })

    test('rows with no stored key get the plain US reading once, and are then keyed', async () => {
      const user = await createTestUser(database, 'backfill')
      try {
        const id = await seedLocal(user, { display_name: 'Old Row' })
        await database.admin
          .query('CREATE phone SET owner = $owner, contact = $contact, phone = "(212) 555-0100"', {
            owner: user.id,
            contact: new RecordId('contact', id),
          })
          .collect()
        expect(await keysOf(user)).toEqual({ '(212) 555-0100': undefined })

        const result = await reconcileGoogleContacts(user.db, user.id, [
          { resourceName: 'people/old', names: [{ displayName: 'Old Row' }], phoneNumbers: [{ value: '212-555-0100' }] },
        ])
        expect(result).toMatchObject({ imported: 0, updated: 1 })
        expect(await keysOf(user)).toEqual({ '(212) 555-0100': '+12125550100' })
      } finally {
        await user.db.close()
      }
    })

    test('backfill: bare numbers on Google contacts are not keyable; iCloud, manual, and +-prefixed rows are keyed', async () => {
      const user = await createTestUser(database, 'backfill-google')
      try {
        const googleContact = await seedLocal(user, { display_name: 'From Google' }, { googleId: 'people/old-google' })
        const icloudContact = await seedLocal(user, { display_name: 'From iCloud' })
        const manualContact = await seedLocal(user, { display_name: 'Manual' })
        await user.db
          .query(
            `CREATE platform_link SET owner = $owner, contact = $icloud, platform = 'icloud', platform_id = 'uid-old'`,
            { owner: user.id, icloud: new RecordId('contact', icloudContact) }
          )
          .collect()
        const rows: [string, string][] = [
          [googleContact, '(212) 555-0100'],
          [googleContact, ['+1', '212 555 0101'].join(' ')],
          [icloudContact, '(212) 555-0102'],
          [manualContact, '(212) 555-0103'],
        ]
        for (const [contact, phone] of rows) {
          await database.admin
            .query('CREATE phone SET owner = $owner, contact = $contact, phone = $phone', {
              owner: user.id,
              contact: new RecordId('contact', contact),
              phone,
            })
            .collect()
        }

        expect(await backfillPhoneKeys(user.db)).toBe(4)
        expect(await keysOf(user)).toEqual({
          '(212) 555-0100': null,
          [['+1', '212 555 0101'].join(' ')]: '+12125550101',
          '(212) 555-0102': '+12125550102',
          '(212) 555-0103': '+12125550103',
        })
        // Nothing left to do on a second pass.
        expect(await backfillPhoneKeys(user.db)).toBe(0)
      } finally {
        await user.db.close()
      }
    })

    test('backfill never overwrites a row that was edited or keyed after it was read', async () => {
      const user = await createTestUser(database, 'backfill-guard')
      try {
        const id = await seedLocal(user, { display_name: 'Racy' })
        const create = (phone: string) =>
          database.admin
            .query('CREATE phone SET owner = $owner, contact = $contact, phone = $phone', {
              owner: user.id,
              contact: new RecordId('contact', id),
              phone,
            })
            .collect()
        await create('(212) 555-0100')
        await create('(212) 555-0101')
        await create('(212) 555-0102')

        const { stale, release } = withHeldIdentityIndex(user.db, 'phone_key = NONE')
        const running = backfillPhoneKeys(stale)
        await Bun.sleep(100)
        // While the backfill holds its read: one row gets its key from someone
        // else, one has its raw text edited, one is left alone.
        await database.admin.query("UPDATE phone SET phone_key = '+12125550199' WHERE phone = '(212) 555-0100'").collect()
        await database.admin.query("UPDATE phone SET phone = '(313) 555-0100' WHERE phone = '(212) 555-0101'").collect()
        release()
        await running

        expect(await keysOf(user)).toEqual({
          '(212) 555-0100': '+12125550199', // the concurrent key stands
          '(313) 555-0100': undefined, // edited: stays unkeyed, recomputed next time
          '(212) 555-0102': '+12125550102', // untouched: keyed
        })
        expect(await backfillPhoneKeys(user.db)).toBe(1)
        expect(await keysOf(user)).toMatchObject({ '(313) 555-0100': '+13135550100' })
      } finally {
        await user.db.close()
      }
    })

    test('editing a phone\'s raw text without a new key clears the old key, so it is recomputed, never trusted', async () => {
      const user = await createTestUser(database, 'edited')
      try {
        const id = await seedLocal(user, { display_name: 'Edited' }, { phones: ['(212) 555-0100'] })
        expect(await keysOf(user)).toEqual({ '(212) 555-0100': '+12125550100' })

        await user.db.query('UPDATE phone SET phone = "(202) 555-0143"').collect()
        expect(await keysOf(user)).toEqual({ '(202) 555-0143': undefined })

        // Matching uses the recomputed key for the new text, not the old number.
        const result = await reconcileGoogleContacts(user.db, user.id, [
          { resourceName: 'people/new-number', names: [{ displayName: 'Edited' }], phoneNumbers: [{ value: '202-555-0143' }] },
          { resourceName: 'people/old-number', names: [{ displayName: 'Stranger' }], phoneNumbers: [{ value: '212-555-0100' }] },
        ])
        expect(result).toMatchObject({ imported: 1, updated: 1, skipped: [] })
        expect((await getContact(user.db, id))!.platform_links.map((l) => l.platform_id)).toEqual(['people/new-number'])
        expect(await keysOf(user)).toMatchObject({ '(202) 555-0143': '+12025550143' })

        // Supplying the new key with the edit is accepted as is.
        await user.db.query('UPDATE phone SET phone = "(313) 555-0100", phone_key = "+13135550100" WHERE phone = "(202) 555-0143"').collect()
        expect(await keysOf(user)).toMatchObject({ '(313) 555-0100': '+13135550100' })
      } finally {
        await user.db.close()
      }
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
