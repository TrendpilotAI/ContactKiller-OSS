import { describe, expect, test } from 'bun:test'
import { getSurrealAdminConfig, getSurrealConfig, isSignupEnabled } from '@/lib/db/config'

describe('SurrealDB configuration', () => {
  test('defaults to a local instance', () => {
    expect(getSurrealConfig({})).toEqual({
      url: 'http://127.0.0.1:8000',
      namespace: 'contactkiller',
      database: 'contactkiller',
    })
  })

  test('rejects unusable URLs and unsafe identifiers', () => {
    expect(() => getSurrealConfig({ SURREALDB_URL: 'not a url' })).toThrow('absolute URL')
    expect(() => getSurrealConfig({ SURREALDB_URL: 'file:///etc/passwd' })).toThrow('http, https, ws, or wss')
    expect(() => getSurrealConfig({ SURREALDB_NAMESPACE: 'x`; REMOVE DATABASE y' })).toThrow('SURREALDB_NAMESPACE')
    expect(() => getSurrealConfig({ SURREALDB_DATABASE: 'has space' })).toThrow('SURREALDB_DATABASE')
  })

  test('root credentials are required only for provisioning', () => {
    expect(() => getSurrealAdminConfig({})).toThrow('SURREALDB_ROOT_USER')
    expect(
      getSurrealAdminConfig({ SURREALDB_ROOT_USER: 'root', SURREALDB_ROOT_PASSWORD: 'pw' })
    ).toMatchObject({ user: 'root', password: 'pw' })
    // compose.env.example ships an empty password so nobody runs with a default.
    expect(() => getSurrealAdminConfig({ SURREALDB_ROOT_USER: 'root', SURREALDB_ROOT_PASSWORD: '' })).toThrow('SURREALDB_ROOT_PASSWORD')
    expect(() =>
      getSurrealAdminConfig({ SURREALDB_ROOT_USER: 'root', SURREALDB_ROOT_PASSWORD: 'replace-with-a-local-development-password' })
    ).toThrow('placeholder')
  })

  test('sign-up is opt-in', () => {
    expect(isSignupEnabled({})).toBe(false)
    expect(isSignupEnabled({ CONTACTKILLER_ALLOW_SIGNUP: 'false' })).toBe(false)
    expect(isSignupEnabled({ CONTACTKILLER_ALLOW_SIGNUP: 'TRUE' })).toBe(true)
  })
})
