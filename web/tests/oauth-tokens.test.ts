import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { getOAuthStatus, getOAuthToken, saveOAuthToken } from '@/lib/db/oauth-tokens'
import { createTestUser, startTestDatabase, surrealAvailable, type TestDatabase, type TestUser } from './support/surreal'

describe.skipIf(!surrealAvailable)('OAuth token storage', () => {
  const key = randomBytes(32)
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

  const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000)

  test('round-trips tokens and stores only ciphertext', async () => {
    const expiresAt = inOneHour()
    await saveOAuthToken(alice.db, key, alice.id, 'google', {
      accessToken: 'synthetic-access-token',
      refreshToken: 'synthetic-refresh-token',
      expiresAt,
    })

    const stored = await getOAuthToken(alice.db, key, alice.id, 'google')
    expect(stored).toMatchObject({
      accessToken: 'synthetic-access-token',
      refreshToken: 'synthetic-refresh-token',
    })
    expect(stored!.expiresAt.getTime()).toBe(expiresAt.getTime())

    const [raw] = await database.admin.query('SELECT * FROM oauth_token').collect<[Record<string, unknown>[]]>()
    const serialized = JSON.stringify(raw)
    expect(serialized).not.toContain('synthetic-access-token')
    expect(serialized).not.toContain('synthetic-refresh-token')
    expect(String(raw[0].access_token_enc).startsWith('v1.')).toBe(true)
  })

  test('reconnecting upserts a single row and keeps the refresh token when none is returned', async () => {
    await saveOAuthToken(alice.db, key, alice.id, 'google', {
      accessToken: 'synthetic-access-token-2',
      refreshToken: null,
      expiresAt: inOneHour(),
    })
    const [rows] = await database.admin.query('SELECT * FROM oauth_token').collect<[unknown[]]>()
    expect(rows).toHaveLength(1)

    const stored = await getOAuthToken(alice.db, key, alice.id, 'google')
    expect(stored).toMatchObject({
      accessToken: 'synthetic-access-token-2',
      refreshToken: 'synthetic-refresh-token',
    })
  })

  test('status needs no key and reports expiry', async () => {
    const status = await getOAuthStatus(alice.db, 'google')
    expect(status!.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(status!.hasRefreshToken).toBe(true)
    expect(await getOAuthStatus(alice.db, 'icloud')).toBeNull()
  })

  test('a different key cannot decrypt', async () => {
    await expect(getOAuthToken(alice.db, randomBytes(32), alice.id, 'google')).rejects.toThrow()
  })

  test("another user can neither read nor overwrite someone else's token", async () => {
    expect(await getOAuthStatus(bob.db, 'google')).toBeNull()
    expect(await getOAuthToken(bob.db, key, bob.id, 'google')).toBeNull()

    await saveOAuthToken(bob.db, key, bob.id, 'google', {
      accessToken: 'bobs-synthetic-token',
      expiresAt: inOneHour(),
    })
    expect((await getOAuthToken(alice.db, key, alice.id, 'google'))!.accessToken).toBe('synthetic-access-token-2')
    expect((await getOAuthToken(bob.db, key, bob.id, 'google'))!.accessToken).toBe('bobs-synthetic-token')
  })

  test('a ciphertext moved to another owner does not decrypt', async () => {
    const [[aliceRow]] = await database.admin
      .query('SELECT access_token_enc FROM oauth_token WHERE owner = $owner', { owner: alice.id })
      .collect<[{ access_token_enc: string }[]]>()
    await database.admin
      .query('UPDATE oauth_token SET access_token_enc = $enc WHERE owner = $owner', {
        enc: aliceRow.access_token_enc,
        owner: bob.id,
      })
      .collect()
    await expect(getOAuthToken(bob.db, key, bob.id, 'google')).rejects.toThrow()
  })

  test('only known providers are accepted', async () => {
    await expect(
      // @ts-expect-error unknown provider is rejected by the schema assertion
      saveOAuthToken(alice.db, key, alice.id, 'myspace', { accessToken: 'x', expiresAt: inOneHour() })
    ).rejects.toThrow()
  })
})
