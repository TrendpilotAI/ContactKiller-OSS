import { NotAllowedError, NotFoundError, QueryError, ThrownError } from 'surrealdb'
import { ACCESS_METHOD, connectAnonymous } from './client'
import type { SurrealConfig } from './config'

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'invalid_email'
  | 'invalid_password_length'
  | 'email_taken'

export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 256

// Matches the lifetime of `DURATION FOR TOKEN` in the account access method.
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code)
    this.name = 'AuthError'
  }
}

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  invalid_credentials: 'Email or password is incorrect.',
  invalid_email: 'Enter a valid email address.',
  invalid_password_length: `Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`,
  email_taken: 'Sign-up failed. That email may already be registered.',
}

function validateCredentials(email: unknown, password: unknown): { email: string; password: string } {
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new AuthError('invalid_credentials')
  }
  const normalized = email.trim().toLowerCase()
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new AuthError('invalid_email')
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError('invalid_password_length')
  }
  return { email: normalized, password }
}

function accessToken(tokens: unknown): string {
  const token = (tokens as { access?: unknown } | null)?.access
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('SurrealDB did not return an access token.')
  }
  return token
}

export async function signUp(config: SurrealConfig, email: unknown, password: unknown): Promise<string> {
  const credentials = validateCredentials(email, password)
  const db = await connectAnonymous(config)
  try {
    const tokens = await db.signup({
      namespace: config.namespace,
      database: config.database,
      access: ACCESS_METHOD,
      variables: credentials,
    })
    return accessToken(tokens)
  } catch (error) {
    if (error instanceof ThrownError) {
      const code = error.message.match(/invalid_(?:email|password_length|credentials)/)?.[0]
      if (code) throw new AuthError(code as AuthErrorCode)
    }
    // The only other way the SIGNUP block fails is the unique email index.
    if (error instanceof QueryError) throw new AuthError('email_taken')
    throw error
  } finally {
    await db.close().catch(() => undefined)
  }
}

export async function signIn(config: SurrealConfig, email: unknown, password: unknown): Promise<string> {
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new AuthError('invalid_credentials')
  }
  const db = await connectAnonymous(config)
  try {
    const tokens = await db.signin({
      namespace: config.namespace,
      database: config.database,
      access: ACCESS_METHOD,
      variables: { email: email.trim().toLowerCase(), password },
    })
    return accessToken(tokens)
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof NotAllowedError) {
      throw new AuthError('invalid_credentials')
    }
    throw error
  } finally {
    await db.close().catch(() => undefined)
  }
}
