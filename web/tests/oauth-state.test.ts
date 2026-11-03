import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { OAUTH_STATE_TTL_MS, createOAuthState, verifyOAuthState } from '@/lib/oauth-state'

const secret = randomBytes(32)
const now = new Date('2026-10-09T12:00:00Z')

describe('OAuth state binding', () => {
  test('verifies for the user it was issued to, and only then', () => {
    const state = createOAuthState(secret, 'alice', now)
    expect(verifyOAuthState(secret, state, 'alice', now)).toBe(true)
    expect(verifyOAuthState(secret, state, 'bob', now)).toBe(false)
    expect(verifyOAuthState(secret, state, 'alice2', now)).toBe(false)
    expect(verifyOAuthState(secret, state, '', now)).toBe(false)
  })

  test('every state is unique', () => {
    expect(createOAuthState(secret, 'alice', now)).not.toBe(createOAuthState(secret, 'alice', now))
  })

  test('expires after ten minutes and is not valid before it was issued', () => {
    const state = createOAuthState(secret, 'alice', now)
    expect(verifyOAuthState(secret, state, 'alice', new Date(now.getTime() + OAUTH_STATE_TTL_MS))).toBe(true)
    expect(verifyOAuthState(secret, state, 'alice', new Date(now.getTime() + OAUTH_STATE_TTL_MS + 1))).toBe(false)
    expect(verifyOAuthState(secret, state, 'alice', new Date(now.getTime() - 1))).toBe(false)
  })

  test('another secret, tampering, and malformed values all fail', () => {
    const state = createOAuthState(secret, 'alice', now)
    expect(verifyOAuthState(randomBytes(32), state, 'alice', now)).toBe(false)

    const [version, nonce, issuedAt, mac] = state.split('.')
    const flip = (value: string) => `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`
    for (const forged of [
      [version, flip(nonce), issuedAt, mac],
      [version, nonce, String(Number(issuedAt) + 1), mac],
      [version, nonce, issuedAt, flip(mac)],
      ['v2', nonce, issuedAt, mac],
      [version, nonce, issuedAt, ''],
      [version, nonce, issuedAt],
      [version, nonce, issuedAt, mac, 'extra'],
    ]) {
      expect(verifyOAuthState(secret, forged.join('.'), 'alice', now)).toBe(false)
    }
    for (const bad of [null, undefined, '', 'plain-random-hex', 'a.b.c.d', 'v1.x.notanumber.y']) {
      expect(verifyOAuthState(secret, bad as string | null | undefined, 'alice', now)).toBe(false)
    }
  })

  test('the old unsigned format (a bare random value) is never accepted', () => {
    const legacy = randomBytes(32).toString('hex')
    expect(verifyOAuthState(secret, legacy, 'alice', now)).toBe(false)
  })
})
