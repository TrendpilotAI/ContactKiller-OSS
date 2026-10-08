import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RecordId } from 'surrealdb'
import { AuthError, signIn, signUp } from '@/lib/db/auth'
import { connectAnonymous, connectWithToken } from '@/lib/db/client'
import { startTestDatabase, surrealAvailable, type TestDatabase } from './support/surreal'

const PASSWORD = 'correct-horse-battery-1'

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AuthError) return error.code
    throw error
  }
  return 'no error'
}

describe.skipIf(!surrealAvailable)('SurrealDB record auth', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await startTestDatabase()
  })
  afterAll(async () => {
    await database.stop()
  })

  test('sign-up returns a session token that resolves to an app_user', async () => {
    const token = await signUp(database.config, 'Maya@Example.com', PASSWORD)
    const db = await connectWithToken(database.config, token)
    try {
      const [auth] = await db.query('RETURN $auth').collect<[RecordId]>()
      expect(auth.table.name).toBe('app_user')
    } finally {
      await db.close()
    }
  })

  test('passwords are stored as argon2 hashes and emails are normalized', async () => {
    const [rows] = await database.admin
      .query('SELECT email, password_hash FROM app_user')
      .collect<[{ email: string; password_hash: string }[]]>()
    expect(rows[0].email).toBe('maya@example.com')
    expect(rows[0].password_hash.startsWith('$argon2')).toBe(true)
    expect(rows[0].password_hash).not.toContain(PASSWORD)
  })

  test('sign-in is case-insensitive on email and rejects wrong passwords', async () => {
    expect(await signIn(database.config, 'MAYA@example.com', PASSWORD)).toBeTruthy()
    expect(await codeOf(signIn(database.config, 'maya@example.com', 'wrong-password-123'))).toBe('invalid_credentials')
    expect(await codeOf(signIn(database.config, 'nobody@example.com', PASSWORD))).toBe('invalid_credentials')
    expect(await codeOf(signIn(database.config, { $ne: '' }, PASSWORD))).toBe('invalid_credentials')
  })

  test('sign-up validates email and password and refuses duplicates', async () => {
    expect(await codeOf(signUp(database.config, 'not-an-email', PASSWORD))).toBe('invalid_email')
    expect(await codeOf(signUp(database.config, 'short@example.com', 'short'))).toBe('invalid_password_length')
    expect(await codeOf(signUp(database.config, 'maya@example.com', PASSWORD))).toBe('email_taken')
    expect(await codeOf(signUp(database.config, 'MAYA@example.com', PASSWORD))).toBe('email_taken')
  })

  test('the database itself enforces the password and email policy', async () => {
    const db = await connectAnonymous(database.config)
    try {
      await expect(
        db.signup({
          namespace: database.config.namespace,
          database: database.config.database,
          access: 'account',
          variables: { email: 'weak@example.com', password: 'short' },
        })
      ).rejects.toThrow('invalid_password_length')
      await expect(
        db.signup({
          namespace: database.config.namespace,
          database: database.config.database,
          access: 'account',
          variables: { email: 'bad', password: PASSWORD },
        })
      ).rejects.toThrow('invalid_email')
    } finally {
      await db.close()
    }
  })

  test('record users cannot read accounts or password hashes', async () => {
    const token = await signIn(database.config, 'maya@example.com', PASSWORD)
    const db = await connectWithToken(database.config, token)
    try {
      const [rows] = await db.query('SELECT * FROM app_user').collect<[unknown[]]>()
      expect(rows).toEqual([])
    } finally {
      await db.close()
    }
  })

  test('garbage and tampered tokens are rejected', async () => {
    await expect(connectWithToken(database.config, 'garbage')).rejects.toThrow()
    const token = await signIn(database.config, 'maya@example.com', PASSWORD)
    const [header, payload, signature] = token.split('.')
    const forged = [header, payload, `${signature.slice(0, -3)}AAA`].join('.')
    await expect(connectWithToken(database.config, forged)).rejects.toThrow()
  })

  test('an anonymous connection cannot query at all', async () => {
    const db = await connectAnonymous(database.config)
    try {
      for (const table of ['contact', 'email', 'oauth_token', 'conflict', 'app_user']) {
        await expect(db.query(`SELECT * FROM ${table}`).collect()).rejects.toThrow('Anonymous access not allowed')
      }
    } finally {
      await db.close()
    }
  })
})
