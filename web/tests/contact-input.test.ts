import { describe, expect, test } from 'bun:test'
import { parseContactPatch, parseNewContact } from '@/lib/contact-input'

describe('parseNewContact', () => {
  test('derives a display name and defaults labels', () => {
    const parsed = parseNewContact({
      first_name: 'Maya',
      last_name: 'Chen',
      emails: [{ email: 'maya@example.com' }],
      phones: [{ phone: '+1 202 555 0143', label: 'work' }],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.fields.display_name).toBe('Maya Chen')
    expect(parsed.value.fields.is_financial_advisor).toBe(false)
    expect(parsed.value.emails).toEqual([{ value: 'maya@example.com', label: undefined }])
    expect(parsed.value.phones?.[0].label).toBe('work')
  })

  test('falls back to email, then Unknown', () => {
    const byEmail = parseNewContact({ emails: [{ email: 'solo@example.com' }] })
    expect(byEmail.ok && byEmail.value.fields.display_name).toBe('solo@example.com')
    const unknown = parseNewContact({})
    expect(unknown.ok && unknown.value.fields.display_name).toBe('Unknown')
  })

  test('rejects malformed input', () => {
    expect(parseNewContact(null).ok).toBe(false)
    expect(parseNewContact({ first_name: 5 }).ok).toBe(false)
    expect(parseNewContact({ is_financial_advisor: 'yes' }).ok).toBe(false)
    expect(parseNewContact({ emails: 'a@example.com' }).ok).toBe(false)
    expect(parseNewContact({ emails: [{ email: '' }] }).ok).toBe(false)
    expect(parseNewContact({ phones: [{ number: '1' }] }).ok).toBe(false)
  })
})

describe('parseContactPatch', () => {
  test('keeps absent fields absent and null explicit', () => {
    const parsed = parseContactPatch({ first_name: null })
    expect(parsed).toEqual({
      ok: true,
      value: { first_name: null, last_name: undefined, is_financial_advisor: undefined },
    })
  })

  test('ignores fields that are not patchable', () => {
    const parsed = parseContactPatch({ owner: 'app_user:other', display_name: 'x' })
    expect(parsed.ok && Object.values(parsed.value).every((value) => value === undefined)).toBe(true)
  })

  test('rejects wrong types', () => {
    expect(parseContactPatch({ is_financial_advisor: 'true' }).ok).toBe(false)
    expect(parseContactPatch('nope').ok).toBe(false)
  })
})
