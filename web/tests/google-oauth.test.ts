import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { getOAuthStatus, getOAuthToken, saveOAuthToken } from '@/lib/db/oauth-tokens'
import { createOAuthState } from '@/lib/oauth-state'
import { completeGoogleCallback } from '@/lib/sync/google-oauth'
import { createTestUser, startTestDatabase, surrealAvailable, type TestDatabase, type TestUser } from './support/surreal'

describe.skipIf(!surrealAvailable)('Google OAuth callback', () => {
  const secret = randomBytes(32)
  let database: TestDatabase
  let alice: TestUser
  let bob: TestUser

  const googleGrants = (accessToken: string) => {
    const calls: URLSearchParams[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init.body as URLSearchParams)
      return new Response(JSON.stringify({ access_token: accessToken, refresh_token: `${accessToken}-refresh`, expires_in: 3600 }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
  }

  // The session that finishes the flow is `completedBy`; `state` is what the
  // browser's cookie and Google's redirect both carry.
  const callback = (completedBy: TestUser, state: string | null, fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) =>
    completeGoogleCallback({
      db: completedBy.db,
      userId: completedBy.id,
      secret,
      state,
      cookieState: state ?? undefined,
      code: 'synthetic-auth-code',
      redirectUri: 'http://localhost:3000/api/auth/google/callback',
      clientId: 'synthetic-client-id',
      clientSecret: 'synthetic-client-secret',
      fetchImpl,
      ...overrides,
    })

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

  test('the user who started the flow completes it, and the tokens are stored under that user', async () => {
    const { fetchImpl, calls } = googleGrants('alice-access')
    const state = createOAuthState(secret, String(alice.id.id))
    expect(await callback(alice, state, fetchImpl)).toEqual({ status: 'connected' })
    expect(calls).toHaveLength(1)
    expect(calls[0].get('code')).toBe('synthetic-auth-code')
    expect(await getOAuthToken(alice.db, secret, alice.id, 'google')).toMatchObject({
      accessToken: 'alice-access',
      refreshToken: 'alice-access-refresh',
    })
    expect(await getOAuthStatus(bob.db, 'google')).toBeNull()
  })

  test('switching accounts during consent is rejected: nothing is exchanged and nothing is stored', async () => {
    // Bob already has his own connection, which must survive untouched.
    await saveOAuthToken(bob.db, secret, bob.id, 'google', {
      accessToken: 'bobs-own-access',
      refreshToken: 'bobs-own-refresh',
      expiresAt: new Date(Date.now() + 3600 * 1000),
    })

    // Alice starts consent; the browser then signs out and back in as Bob
    // before Google redirects, so Bob's session completes Alice's flow.
    const state = createOAuthState(secret, String(alice.id.id))
    const { fetchImpl, calls } = googleGrants('alices-google-grant')
    expect(await callback(bob, state, fetchImpl)).toEqual({ status: 'invalid_state' })

    expect(calls).toHaveLength(0)
    expect(await getOAuthToken(bob.db, secret, bob.id, 'google')).toMatchObject({
      accessToken: 'bobs-own-access',
      refreshToken: 'bobs-own-refresh',
    })
    const [rows] = await database.admin.query('SELECT * FROM oauth_token').collect<[unknown[]]>()
    expect(JSON.stringify(rows)).not.toContain('alices-google-grant')
  })

  test('the reverse direction is rejected too', async () => {
    const { fetchImpl, calls } = googleGrants('bobs-grant')
    const state = createOAuthState(secret, String(bob.id.id))
    expect(await callback(alice, state, fetchImpl)).toEqual({ status: 'invalid_state' })
    expect(calls).toHaveLength(0)
    expect((await getOAuthToken(alice.db, secret, alice.id, 'google'))!.accessToken).toBe('alice-access')
  })

  test('a missing, unsigned, tampered, expired or mismatched state is rejected without exchanging a code', async () => {
    const { fetchImpl, calls } = googleGrants('should-never-be-stored')
    const good = createOAuthState(secret, String(alice.id.id))
    const [version, nonce, issuedAt, mac] = good.split('.')
    const tampered = [version, nonce, issuedAt, `${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`].join('.')
    const legacyUnsigned = randomBytes(32).toString('hex')
    const stale = createOAuthState(secret, String(alice.id.id), new Date(Date.now() - 11 * 60 * 1000))
    const signedWithAnotherSecret = createOAuthState(randomBytes(32), String(alice.id.id))

    for (const [state, cookieState] of [
      [null, undefined],
      [good, undefined], // no cookie
      [good, createOAuthState(secret, String(alice.id.id))], // cookie from another flow
      [tampered, tampered],
      [legacyUnsigned, legacyUnsigned], // the old format, with no binding
      [stale, stale],
      [signedWithAnotherSecret, signedWithAnotherSecret],
    ] as [string | null, string | undefined][]) {
      expect(await callback(alice, state, fetchImpl, { cookieState })).toEqual({ status: 'invalid_state' })
    }
    expect(calls).toHaveLength(0)
    expect((await getOAuthToken(alice.db, secret, alice.id, 'google'))!.accessToken).toBe('alice-access')
  })

  test('an authorised callback still needs a code, and failures from Google store nothing', async () => {
    const state = createOAuthState(secret, String(alice.id.id))
    const { fetchImpl, calls } = googleGrants('unused')
    expect(await callback(alice, state, fetchImpl, { code: null })).toEqual({ status: 'missing_params' })
    expect(calls).toHaveLength(0)

    const refused = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch
    expect(await callback(alice, state, refused)).toEqual({ status: 'token_exchange_failed' })
    const offline = (async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    expect(await callback(alice, state, offline)).toEqual({ status: 'callback_failed' })
    expect((await getOAuthToken(alice.db, secret, alice.id, 'google'))!.accessToken).toBe('alice-access')
  })
})
