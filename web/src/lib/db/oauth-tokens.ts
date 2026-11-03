import { DateTime, type RecordId } from 'surrealdb'
import type { Db } from './client'
import { decryptSecret, encryptSecret } from './crypto'
import type { OAuthProvider } from './types'

export interface OAuthTokenInput {
  accessToken: string
  refreshToken?: string | null
  expiresAt: Date
}

export interface StoredOAuthToken {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  createdAt: Date
}

export interface OAuthStatus {
  expiresAt: Date
  createdAt: Date
  hasRefreshToken: boolean
}

// The stored ciphertext cannot be opened with the configured key: the key was
// rotated, or the row was tampered with or moved. Recoverable by reconnecting.
export class TokenDecryptError extends Error {
  constructor() {
    super('Stored provider token could not be decrypted.')
    this.name = 'TokenDecryptError'
  }
}

function context(owner: RecordId, provider: OAuthProvider, field: string): string {
  return `oauth_token:${String(owner.id)}:${provider}:${field}`
}

// Tokens are encrypted before they reach SurrealDB, so database dumps, logs,
// and replicas never contain a usable provider credential.
export async function saveOAuthToken(
  db: Db,
  key: Buffer,
  owner: RecordId,
  provider: OAuthProvider,
  token: OAuthTokenInput
): Promise<void> {
  const accessEnc = encryptSecret(token.accessToken, key, context(owner, provider, 'access'))
  // A reconnect that returns no refresh token must not discard the one we
  // already hold, so the refresh column is only written when there is one.
  const refreshEnc = token.refreshToken
    ? encryptSecret(token.refreshToken, key, context(owner, provider, 'refresh'))
    : null
  await db
    .query(
      `INSERT INTO oauth_token {
         owner: $owner, provider: $provider,
         access_token_enc: $accessEnc,
         ${refreshEnc ? 'refresh_token_enc: $refreshEnc,' : ''}
         expires_at: $expiresAt
       } ON DUPLICATE KEY UPDATE
         access_token_enc = $input.access_token_enc,
         ${refreshEnc ? 'refresh_token_enc = $input.refresh_token_enc,' : ''}
         expires_at = $input.expires_at`,
      { owner, provider, accessEnc, refreshEnc, expiresAt: new DateTime(token.expiresAt) }
    )
    .collect()
}

export async function getOAuthToken(
  db: Db,
  key: Buffer,
  owner: RecordId,
  provider: OAuthProvider
): Promise<StoredOAuthToken | null> {
  const [rows] = await db
    .query(
      `SELECT access_token_enc, refresh_token_enc, expires_at, created_at
         FROM oauth_token WHERE provider = $provider`,
      { provider }
    )
    .collect<[{
      access_token_enc: string
      refresh_token_enc: string | null
      expires_at: DateTime
      created_at: DateTime
    }[]]>()
  const row = rows[0]
  if (!row) return null
  try {
    return {
      accessToken: decryptSecret(row.access_token_enc, key, context(owner, provider, 'access')),
      refreshToken: row.refresh_token_enc
        ? decryptSecret(row.refresh_token_enc, key, context(owner, provider, 'refresh'))
        : null,
      expiresAt: row.expires_at.toDate(),
      createdAt: row.created_at.toDate(),
    }
  } catch {
    throw new TokenDecryptError()
  }
}

// Connection status never needs the secret, so it never decrypts.
export async function getOAuthStatus(db: Db, provider: OAuthProvider): Promise<OAuthStatus | null> {
  const [rows] = await db
    .query(
      `SELECT expires_at, created_at, refresh_token_enc != NONE AND refresh_token_enc != NULL AS has_refresh
         FROM oauth_token WHERE provider = $provider`,
      { provider }
    )
    .collect<[{ expires_at: DateTime; created_at: DateTime; has_refresh: boolean }[]]>()
  const row = rows[0]
  return row
    ? {
        expiresAt: row.expires_at.toDate(),
        createdAt: row.created_at.toDate(),
        hasRefreshToken: row.has_refresh === true,
      }
    : null
}
