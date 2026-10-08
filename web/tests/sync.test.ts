import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { people_v1 } from 'googleapis'
import { listContacts } from '@/lib/db/contacts'
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
    test('imports new contacts with emails, phones, links, and advisor detection', async () => {
      const result = await reconcileGoogleContacts(alice.db, alice.id, [maya, advisor])
      expect(result).toEqual({ imported: 2, updated: 0, conflicts: 0, errors: [] })

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

    test('is idempotent: a second run updates in place and creates no duplicates', async () => {
      const changed: Person = { ...maya, organizations: [{ name: 'Renamed Studio', title: 'Lead' }] }
      const result = await reconcileGoogleContacts(alice.db, alice.id, [changed, advisor])
      expect(result).toEqual({ imported: 0, updated: 2, conflicts: 0, errors: [] })

      const contacts = await listContacts(alice.db)
      expect(contacts).toHaveLength(2)
      expect(contacts.find((c) => c.first_name === 'Maya')).toMatchObject({ company: 'Renamed Studio', job_title: 'Lead' })
      const links = contacts.flatMap((c) => c.platform_links)
      expect(links).toHaveLength(2)
      expect(links.every((l) => l.last_synced_at !== null)).toBe(true)
    })

    test('matches an existing contact by email (case-insensitive) or normalized phone', async () => {
      const byEmail: Person = { resourceName: 'people/c2001', names: [{ givenName: 'M.' }], emailAddresses: [{ value: 'MAYA@example.COM' }] }
      const byPhone: Person = { resourceName: 'people/c2002', names: [{ givenName: 'Sam', familyName: 'R.' }], phoneNumbers: [{ value: '+1 202 555 0143' }] }
      const result = await reconcileGoogleContacts(alice.db, alice.id, [byEmail, byPhone])
      expect(result).toMatchObject({ imported: 0, updated: 2, errors: [] })
      expect(await listContacts(alice.db)).toHaveLength(2)
    })

    test('contacts without a provider link are still matched', async () => {
      const manual = await listContacts(bob.db)
      expect(manual).toEqual([])
      await bob.db
        .query(
          `BEGIN;
           LET $c = (CREATE ONLY contact CONTENT { owner: $owner, display_name: 'Manual Entry' });
           CREATE email CONTENT { owner: $owner, contact: $c.id, email: 'manual@example.com' };
           COMMIT;`,
          { owner: bob.id }
        )
        .collect()
      const result = await reconcileGoogleContacts(bob.db, bob.id, [
        { resourceName: 'people/c3001', names: [{ displayName: 'Manual Entry' }], emailAddresses: [{ value: 'manual@example.com' }] },
      ])
      expect(result).toMatchObject({ imported: 0, updated: 1 })
      expect(await listContacts(bob.db)).toHaveLength(1)
    })

    test("one user's import never matches or touches another user's contacts", async () => {
      const before = await listContacts(alice.db)
      const result = await reconcileGoogleContacts(bob.db, bob.id, [maya])
      expect(result).toMatchObject({ imported: 1, updated: 0 })
      expect(await listContacts(alice.db)).toEqual(before)
    })

    test('records without a provider id are skipped and do not stop the rest', async () => {
      const carol = await createTestUser(database, 'carol')
      try {
        const result = await reconcileGoogleContacts(carol.db, carol.id, [
          { resourceName: 'people/c4001', names: [{ displayName: 'Fine One' }] },
          { names: [{ displayName: 'No Resource Name' }] },
          { resourceName: 'people/c4002', names: [{ displayName: 'Fine Two' }] },
        ])
        expect(result).toEqual({ imported: 2, updated: 0, conflicts: 0, errors: [] })
        expect(await listContacts(carol.db)).toHaveLength(2)
      } finally {
        await carol.db.close()
      }
    })

    test('phone normalization matches formatting variants', () => {
      expect(normalizePhone('(202) 555-0143')).toBe('+12025550143')
      expect(normalizePhone('+1 202 555 0143')).toBe('+12025550143')
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
