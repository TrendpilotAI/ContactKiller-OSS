import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RecordId } from 'surrealdb'
import { AuthError, MAX_PASSWORD_LENGTH, signIn, signUp } from '@/lib/db/auth'
import { connectAnonymous, connectWithToken } from '@/lib/db/client'
import { isSignupEnabledInDatabase, setSignupEnabled } from '@/lib/db/settings'
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

  describe('database-side sign-up gate', () => {
    const directSignup = async (email: string) => {
      const db = await connectAnonymous(database.config)
      try {
        return await db.signup({
          namespace: database.config.namespace,
          database: database.config.database,
          access: 'account',
          variables: { email, password: PASSWORD },
        })
      } finally {
        await db.close()
      }
    }

    test('a direct SurrealDB sign-up fails while sign-up is disabled, and creates no user', async () => {
      await setSignupEnabled(database.admin, false)
      try {
        await expect(directSignup('direct@example.com')).rejects.toThrow('signup_disabled')
        expect(await codeOf(signUp(database.config, 'viaapp@example.com', PASSWORD))).toBe('signup_disabled')
        const [rows] = await database.admin
          .query("SELECT * FROM app_user WHERE email IN ['direct@example.com', 'viaapp@example.com']")
          .collect<[unknown[]]>()
        expect(rows).toEqual([])
      } finally {
        await setSignupEnabled(database.admin, true)
      }
    })

    test('sign-up works again once the setting is enabled', async () => {
      expect(await directSignup('enabled@example.com')).toHaveProperty('access')
    })

    test('a fresh migration leaves sign-up disabled and fails closed without the setting', async () => {
      const fresh = await startTestDatabase({ signup: false })
      try {
        expect(await codeOf(signUp(fresh.config, 'fresh@example.com', PASSWORD))).toBe('signup_disabled')
        await fresh.admin.query('DELETE setting').collect()
        expect(await codeOf(signUp(fresh.config, 'fresh@example.com', PASSWORD))).toBe('signup_disabled')
      } finally {
        await fresh.stop()
      }
    })

    test('record users cannot read or change the setting', async () => {
      const token = await signIn(database.config, 'maya@example.com', PASSWORD)
      const db = await connectWithToken(database.config, token)
      try {
        const [rows] = await db.query('SELECT * FROM setting').collect<[unknown[]]>()
        expect(rows).toEqual([])
        await db.query('UPSERT setting:signup SET enabled = false').collect()
        expect(await isSignupEnabledInDatabase(database.admin)).toBe(true)
      } finally {
        await db.close()
      }
    })
  })

  describe('sign-in hardening', () => {
    test('over-long passwords are rejected without reaching argon2', async () => {
      const long = 'x'.repeat(MAX_PASSWORD_LENGTH + 1)
      expect(await codeOf(signIn(database.config, 'maya@example.com', long))).toBe('invalid_credentials')

      const db = await connectAnonymous(database.config)
      try {
        await expect(
          db.signin({
            namespace: database.config.namespace,
            database: database.config.database,
            access: 'account',
            variables: { email: 'maya@example.com', password: long },
          })
        ).rejects.toThrow('invalid_credentials')
      } finally {
        await db.close()
      }
    })

    test('unknown and known emails fail the same way, with comparable work', async () => {
      const time = async (email: string) => {
        const start = performance.now()
        expect(await codeOf(signIn(database.config, email, 'wrong-password-123'))).toBe('invalid_credentials')
        return performance.now() - start
      }
      await time('maya@example.com')
      const known = await time('maya@example.com')
      const unknown = await time('nobody-at-all@example.com')
      // Both paths hash with argon2, so an unknown email must not return in a
      // small fraction of the known-email time.
      expect(unknown).toBeGreaterThan(known * 0.4)
    })
  })
})
