import { describe, expect, test } from 'bun:test'
import { safeNextPath } from '@/lib/safe-redirect'

describe('safeNextPath', () => {
  test('keeps same-origin paths with queries', () => {
    expect(safeNextPath('/contacts')).toBe('/contacts')
    expect(safeNextPath('/contacts?filter=fa&search=ma')).toBe('/contacts?filter=fa&search=ma')
    expect(safeNextPath('/settings#x')).toBe('/settings')
  })

  test('a repeated ?next= (array) or any non-string falls back instead of throwing', () => {
    expect(safeNextPath(['/contacts', '/settings'])).toBe('/contacts')
    expect(safeNextPath(['//evil.example'])).toBe('/contacts')
    expect(safeNextPath([], '/home')).toBe('/home')
    expect(safeNextPath(['/settings'], '/home')).toBe('/home')
    for (const odd of [42, {}, null, true, Symbol('x')]) expect(safeNextPath(odd)).toBe('/contacts')
  })

  test('falls back for missing and relative values', () => {
    expect(safeNextPath(undefined)).toBe('/contacts')
    expect(safeNextPath('')).toBe('/contacts')
    expect(safeNextPath('contacts')).toBe('/contacts')
    expect(safeNextPath('../etc', '/home')).toBe('/home')
  })

  test('rejects anything that could leave the origin', () => {
    for (const hostile of [
      '//evil.example',
      '///evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/\u0000/evil.example',
      '/%0a/evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '/..//evil.example',
      '/a\\..\\evil.example',
    ]) {
      const result = safeNextPath(hostile)
      expect(result.startsWith('//')).toBe(false)
      expect(result).not.toContain('evil.example/')
      expect(result === '/contacts' || result.startsWith('/')).toBe(true)
      expect(new URL(result, 'http://app.example').origin).toBe('http://app.example')
    }
  })

  test('control characters and backslashes fall back outright', () => {
    for (const hostile of ['/\t/evil.example', '/\\evil.example', '/ok\nnext']) {
      expect(safeNextPath(hostile)).toBe('/contacts')
    }
  })
})
