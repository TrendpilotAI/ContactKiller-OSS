import { RecordId } from 'surrealdb'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createConflict, listUnresolvedConflicts, resolveConflict } from '@/lib/db/conflicts'
import { createContact, getContact } from '@/lib/db/contacts'
import { createTestUser, startTestDatabase, surrealAvailable, type TestDatabase, type TestUser } from './support/surreal'

describe.skipIf(!surrealAvailable)('conflict review', () => {
  let database: TestDatabase
  let alice: TestUser
  let bob: TestUser
  let contactId: string

  const newConflict = (field: string) =>
    createConflict(alice.db, alice.id, {
      contactKey: contactId,
      field,
      value_a: 'Acme Corp',
      value_b: 'Acme Holdings',
      source_a: 'google',
      source_b: 'icloud',
    })

  beforeAll(async () => {
    database = await startTestDatabase()
    alice = await createTestUser(database, 'alice')
    bob = await createTestUser(database, 'bob')
    contactId = await createContact(alice.db, alice.id, {
      fields: { first_name: 'Maya', last_name: 'Chen', display_name: 'Maya Chen', company: 'Original Co' },
    })
  })
  // The same disagreement can only be on record once, so each test starts clean.
  beforeEach(async () => {
    await database.admin.query('DELETE conflict').collect()
  })
  afterAll(async () => {
    await alice.db.close()
    await bob.db.close()
    await database.stop()
  })

  test('lists unresolved conflicts with the contact name, newest first', async () => {
    const first = await newConflict('company')
    await Bun.sleep(5)
    const second = await newConflict('job_title')

    const conflicts = await listUnresolvedConflicts(alice.db)
    expect(conflicts.map((c) => c.id)).toEqual([second, first])
    expect(conflicts[0]).toMatchObject({
      contact_id: contactId,
      field: 'job_title',
      source_a: 'google',
      source_b: 'icloud',
      resolved: false,
      contact: { first_name: 'Maya', last_name: 'Chen' },
    })
    expect(await listUnresolvedConflicts(bob.db)).toEqual([])
  })

  test('choosing a side applies that value to the contact and marks the conflict resolved', async () => {
    const id = await newConflict('company')
    expect(await resolveConflict(alice.db, id, 'b')).toEqual({ status: 'resolved' })

    expect((await getContact(alice.db, contactId))!.company).toBe('Acme Holdings')
    const [[row]] = await database.admin
      .query('SELECT resolved, resolved_value, resolved_at FROM conflict WHERE id = $id', {
        id: new RecordId('conflict', id),
      })
      .collect<[{ resolved: boolean; resolved_value: string; resolved_at: unknown }[]]>()
    expect(row).toMatchObject({ resolved: true, resolved_value: 'Acme Holdings' })
    expect(row.resolved_at).toBeTruthy()

    expect(await resolveConflict(alice.db, id, 'a')).toEqual({ status: 'already_resolved' })
  })

  test('choosing the other side applies value A', async () => {
    const id = await newConflict('job_title')
    await resolveConflict(alice.db, id, 'a')
    expect((await getContact(alice.db, contactId))!.job_title).toBe('Acme Corp')
  })

  test('skip resolves without touching the contact', async () => {
    const before = (await getContact(alice.db, contactId))!.notes
    const id = await newConflict('notes')
    expect(await resolveConflict(alice.db, id, 'skip')).toEqual({ status: 'resolved' })
    expect((await getContact(alice.db, contactId))!.notes).toBe(before)
    expect((await listUnresolvedConflicts(alice.db)).map((c) => c.id)).not.toContain(id)
  })

  test('only plain contact columns can be applied; anything else is refused and left unresolved', async () => {
    for (const field of ['owner', 'is_financial_advisor', 'email', 'id; REMOVE TABLE contact']) {
      const id = await newConflict(field)
      expect(await resolveConflict(alice.db, id, 'a')).toEqual({ status: 'unsupported_field', field })
      expect((await listUnresolvedConflicts(alice.db)).map((c) => c.id)).toContain(id)
    }
    expect((await getContact(alice.db, contactId))!.is_financial_advisor).toBe(false)
  })

  test('concurrent resolvers: exactly one applies, the rest see it already resolved', async () => {
    for (let round = 0; round < 5; round += 1) {
      await database.admin.query('DELETE conflict').collect()
      const id = await newConflict('company')
      const outcomes = await Promise.all(
        (['a', 'b', 'a', 'b'] as const).map((choice) => resolveConflict(alice.db, id, choice))
      )
      expect(outcomes.filter((outcome) => outcome.status === 'resolved')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome.status === 'already_resolved')).toHaveLength(3)

      // The contact holds the value of whichever resolver won, never a mix, and
      // the conflict records that same value.
      const company = (await getContact(alice.db, contactId))!.company
      const [[row]] = await database.admin
        .query('SELECT resolved_value FROM conflict WHERE id = $id', { id: new RecordId('conflict', id) })
        .collect<[{ resolved_value: string }[]]>()
      expect(['Acme Corp', 'Acme Holdings']).toContain(company as string)
      expect(row.resolved_value).toBe(company as string)
    }
  })

  test('a conflict that vanishes mid-resolve reports not_found, not already_resolved', async () => {
    const id = await newConflict('company')
    await database.admin.query('DELETE $id', { id: new RecordId('conflict', id) }).collect()
    expect(await resolveConflict(alice.db, id, 'a')).toEqual({ status: 'not_found' })
  })

  test("another user cannot resolve someone else's conflict", async () => {
    const id = await newConflict('company')
    expect(await resolveConflict(bob.db, id, 'a')).toEqual({ status: 'not_found' })
    expect(await resolveConflict(alice.db, 'missing', 'a')).toEqual({ status: 'not_found' })
    expect((await listUnresolvedConflicts(alice.db)).map((c) => c.id)).toContain(id)
  })

  test("a conflict cannot be filed against someone else's contact", async () => {
    await expect(
      createConflict(bob.db, bob.id, {
        contactKey: contactId,
        field: 'company',
        value_a: 'x',
        value_b: 'y',
        source_a: null,
        source_b: null,
      })
    ).rejects.toThrow()
  })
})
