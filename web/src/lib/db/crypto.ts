import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

export const TOKEN_KEY_ENV = 'CONTACTKILLER_TOKEN_ENCRYPTION_KEY'

export function parseEncryptionKey(encoded: string | undefined): Buffer {
  const trimmed = encoded?.trim()
  if (!trimmed) {
    throw new Error(
      `Missing ${TOKEN_KEY_ENV}. Generate one with: openssl rand -base64 32`
    )
  }
  const key = Buffer.from(trimmed, 'base64')
  if (key.length !== KEY_BYTES || key.toString('base64') !== trimmed) {
    throw new Error(`${TOKEN_KEY_ENV} must be 32 random bytes encoded as base64.`)
  }
  return key
}

export function getEncryptionKey(env: Record<string, string | undefined> = process.env): Buffer {
  return parseEncryptionKey(env[TOKEN_KEY_ENV])
}

// `context` is authenticated but not stored. Binding it to the owning row
// means a ciphertext copied to another user or provider fails to decrypt.
export function encryptSecret(plaintext: string, key: Buffer, context: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv, tag, ciphertext].map((part) =>
    typeof part === 'string' ? part : part.toString('base64url')
  ).join('.')
}

export function decryptSecret(payload: string, key: Buffer, context: string): string {
  const [version, iv, tag, ciphertext, ...rest] = payload.split('.')
  if (version !== VERSION || !iv || !tag || !ciphertext || rest.length > 0) {
    throw new Error('Unsupported encrypted secret format.')
  }
  const ivBytes = Buffer.from(iv, 'base64url')
  const tagBytes = Buffer.from(tag, 'base64url')
  // GCM accepts shortened tags unless the length is pinned, which would let an
  // attacker weaken authentication by truncating the stored tag.
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) {
    throw new Error('Unsupported encrypted secret format.')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, ivBytes, { authTagLength: TAG_BYTES })
  decipher.setAAD(Buffer.from(context, 'utf8'))
  decipher.setAuthTag(tagBytes)
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
