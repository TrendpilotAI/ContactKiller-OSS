import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret, parseEncryptionKey } from '@/lib/db/crypto'

const key = randomBytes(32)

describe('token encryption', () => {
  test('round-trips and never exposes the plaintext', () => {
    const sealed = encryptSecret('synthetic-access-token', key, 'ctx')
    expect(sealed.startsWith('v1.')).toBe(true)
    expect(sealed).not.toContain('synthetic-access-token')
    expect(decryptSecret(sealed, key, 'ctx')).toBe('synthetic-access-token')
  })

  test('uses a fresh IV for every encryption', () => {
    expect(encryptSecret('same', key, 'ctx')).not.toBe(encryptSecret('same', key, 'ctx'))
  })

  test('rejects a different key, a different context, and tampering', () => {
    const sealed = encryptSecret('synthetic-access-token', key, 'owner-a:google')
    expect(() => decryptSecret(sealed, randomBytes(32), 'owner-a:google')).toThrow()
    expect(() => decryptSecret(sealed, key, 'owner-b:google')).toThrow()
    const parts = sealed.split('.')
    parts[3] = `${parts[3].slice(0, -2)}AA`
    expect(() => decryptSecret(parts.join('.'), key, 'owner-a:google')).toThrow()
  })

  test('pins the tag and IV lengths', () => {
    const sealed = encryptSecret('synthetic-access-token', key, 'ctx')
    const [version, iv, tag, ciphertext] = sealed.split('.')
    expect(Buffer.from(tag, 'base64url')).toHaveLength(16)

    const shortTag = Buffer.from(tag, 'base64url').subarray(0, 8).toString('base64url')
    expect(() => decryptSecret([version, iv, shortTag, ciphertext].join('.'), key, 'ctx')).toThrow('Unsupported encrypted secret format')
    const oneByte = Buffer.from(tag, 'base64url').subarray(0, 1).toString('base64url')
    expect(() => decryptSecret([version, iv, oneByte, ciphertext].join('.'), key, 'ctx')).toThrow('Unsupported encrypted secret format')
    const longTag = Buffer.concat([Buffer.from(tag, 'base64url'), Buffer.alloc(4)]).toString('base64url')
    expect(() => decryptSecret([version, iv, longTag, ciphertext].join('.'), key, 'ctx')).toThrow('Unsupported encrypted secret format')
    const shortIv = Buffer.from(iv, 'base64url').subarray(0, 8).toString('base64url')
    expect(() => decryptSecret([version, shortIv, tag, ciphertext].join('.'), key, 'ctx')).toThrow('Unsupported encrypted secret format')
    expect(() => decryptSecret([version, iv, '', ciphertext].join('.'), key, 'ctx')).toThrow('Unsupported encrypted secret format')
  })

  test('rejects unknown formats', () => {
    expect(() => decryptSecret('plaintext', key, 'ctx')).toThrow('Unsupported encrypted secret format')
    expect(() => decryptSecret('v2.a.b.c', key, 'ctx')).toThrow('Unsupported encrypted secret format')
  })
})

describe('encryption key parsing', () => {
  test('accepts 32 bytes of base64', () => {
    expect(parseEncryptionKey(randomBytes(32).toString('base64')).length).toBe(32)
  })

  test('rejects missing, short, and non-base64 keys', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow('Missing CONTACTKILLER_TOKEN_ENCRYPTION_KEY')
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow('32 random bytes')
    expect(() => parseEncryptionKey('replace-with-output-of-openssl-rand-base64-32')).toThrow('32 random bytes')
  })
})
