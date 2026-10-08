import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { getOAuthToken, saveOAuthToken } from '@/lib/db/oauth-tokens'
import { getUsableGoogleToken } from '@/lib/sync/google-token'
import { createTestUser, startTestDatabase, surrealAvailable, type TestDatabase, type TestUser } from './support/surreal'

describe.skipIf(!surrealAvailable)('Google token lifecycle', () => {
  const key = randomBytes(32)
  const creds = { clientId: 'synthetic-client-id', clientSecret: 'synthetic-client-secret' }
  let database: TestDatabase
  let user: TestUser

  const seed = (expiresInMs: number, refreshToken: string | null = 'synthetic-refresh') =>
    saveOAuthToken(user.db, key, user.id, 'google', {
      accessToken: 'synthetic-access-old',
      refreshToken,
      expiresAt: new Date(Date.now() + expiresInMs),
    })

  const googleReplies = (status: number, body: unknown) => {
    const calls: URLSearchParams[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init.body as URLSearchParams)
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
  }

  beforeAll(async () => {
    database = await startTestDatabase()
    user = await createTestUser(database, 'tokens')
  })
  afterAll(async () => {
    await user.db.close()
    await database.stop()
  })

  test('not connected without a stored token', async () => {
    expect(await getUsableGoogleToken(user.db, key, user.id, creds)).toEqual({ status: 'not_connected' })
  })

  test('a fresh token is used as-is without calling Google', async () => {
    await seed(60 * 60 * 1000)
    const { fetchImpl, calls } = googleReplies(500, {})
    expect(await getUsableGoogleToken(user.db, key, user.id, { ...creds, fetchImpl })).toEqual({
      status: 'ok',
      accessToken: 'synthetic-access-old',
    })
    expect(calls).toHaveLength(0)
  })

  test('an expired token is refreshed, stored encrypted, and keeps the refresh token', async () => {
    await seed(-1000)
    const { fetchImpl, calls } = googleReplies(200, { access_token: 'synthetic-access-new', expires_in: 3600 })
    const result = await getUsableGoogleToken(user.db, key, user.id, { ...creds, fetchImpl })
    expect(result).toEqual({ status: 'ok', accessToken: 'synthetic-access-new' })

    expect(calls[0].get('grant_type')).toBe('refresh_token')
    expect(calls[0].get('refresh_token')).toBe('synthetic-refresh')
    expect(calls[0].get('client_id')).toBe('synthetic-client-id')

    const stored = await getOAuthToken(user.db, key, user.id, 'google')
    expect(stored).toMatchObject({ accessToken: 'synthetic-access-new', refreshToken: 'synthetic-refresh' })
    expect(stored!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3000 * 1000)
    const [raw] = await database.admin.query('SELECT * FROM oauth_token').collect<[unknown[]]>()
    expect(JSON.stringify(raw)).not.toContain('synthetic-access-new')
  })

  test('a token inside the expiry margin is refreshed too', async () => {
    await seed(30 * 1000)
    const { fetchImpl, calls } = googleReplies(200, { access_token: 'synthetic-access-margin', expires_in: 3600 })
    expect((await getUsableGoogleToken(user.db, key, user.id, { ...creds, fetchImpl })).status).toBe('ok')
    expect(calls).toHaveLength(1)
  })

  test('a revoked refresh token means reconnect; an outage means try again', async () => {
    await seed(-1000)
    const revoked = googleReplies(400, { error: 'invalid_grant' })
    expect(await getUsableGoogleToken(user.db, key, user.id, { ...creds, fetchImpl: revoked.fetchImpl })).toEqual({ status: 'reconnect' })

    const outage = googleReplies(503, { error: 'backend_error' })
    expect(await getUsableGoogleToken(user.db, key, user.id, { ...creds, fetchImpl: outage.fetchImpl })).toEqual({ status: 'refresh_unavailable' })

    const offline = (async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    expect(await getUsableGoogleToken(user.db, key, user.id, { ...creds, fetchImpl: offline })).toEqual({ status: 'refresh_unavailable' })

    const garbage = googleReplies(200, { unexpected: true })
    expect(await getUsableGoogleToken(user.db, key, user.id, { ...creds, fetchImpl: garbage.fetchImpl })).toEqual({ status: 'refresh_unavailable' })
  })

  test('an expired token with no refresh token means reconnect', async () => {
    await database.admin.query('DELETE oauth_token').collect()
    await seed(-1000, null)
    expect(await getUsableGoogleToken(user.db, key, user.id, creds)).toEqual({ status: 'reconnect' })
  })

  test('an undecryptable token means reconnect, not a server error', async () => {
    await seed(60 * 60 * 1000)
    expect(await getUsableGoogleToken(user.db, randomBytes(32), user.id, creds)).toEqual({ status: 'reconnect' })

    await database.admin.query("UPDATE oauth_token SET access_token_enc = 'corrupt'").collect()
    expect(await getUsableGoogleToken(user.db, key, user.id, creds)).toEqual({ status: 'reconnect' })
  })
})
