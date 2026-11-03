import type { ContactPatch, NewContact } from '@/lib/db/contacts'

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

const MAX_TEXT = 1000
const MAX_CHANNELS = 100

function optionalText(value: unknown, name: string): Parsed<string | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || value.length > MAX_TEXT) {
    return { ok: false, error: `${name} must be a string of at most ${MAX_TEXT} characters` }
  }
  return { ok: true, value }
}

function parseChannels(
  value: unknown,
  key: 'email' | 'phone'
): Parsed<{ value: string; label?: string | null }[]> {
  if (value === undefined || value === null) return { ok: true, value: [] }
  if (!Array.isArray(value) || value.length > MAX_CHANNELS) {
    return { ok: false, error: `${key}s must be an array of at most ${MAX_CHANNELS} entries` }
  }
  const channels: { value: string; label?: string | null }[] = []
  for (const entry of value) {
    const channelValue = entry?.[key]
    if (typeof channelValue !== 'string' || channelValue.trim() === '' || channelValue.length > MAX_TEXT) {
      return { ok: false, error: `each ${key} entry needs a non-empty "${key}" string` }
    }
    const label = optionalText(entry.label, 'label')
    if (!label.ok) return label
    channels.push({ value: channelValue.trim(), label: label.value })
  }
  return { ok: true, value: channels }
}

export function parseNewContact(body: unknown): Parsed<NewContact> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'JSON body required' }
  const input = body as Record<string, unknown>

  const firstName = optionalText(input.first_name, 'first_name')
  if (!firstName.ok) return firstName
  const lastName = optionalText(input.last_name, 'last_name')
  if (!lastName.ok) return lastName
  const displayName = optionalText(input.display_name, 'display_name')
  if (!displayName.ok) return displayName
  if (
    input.is_financial_advisor !== undefined &&
    typeof input.is_financial_advisor !== 'boolean'
  ) {
    return { ok: false, error: 'is_financial_advisor must be a boolean' }
  }
  const emails = parseChannels(input.emails, 'email')
  if (!emails.ok) return emails
  const phones = parseChannels(input.phones, 'phone')
  if (!phones.ok) return phones

  const derivedName =
    displayName.value ||
    [firstName.value, lastName.value].filter(Boolean).join(' ') ||
    emails.value[0]?.value ||
    'Unknown'

  return {
    ok: true,
    value: {
      fields: {
        first_name: firstName.value,
        last_name: lastName.value,
        display_name: derivedName,
        is_financial_advisor: input.is_financial_advisor === true,
      },
      emails: emails.value,
      phones: phones.value,
    },
  }
}

export function parseContactPatch(body: unknown): Parsed<ContactPatch> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'JSON body required' }
  const input = body as Record<string, unknown>

  const firstName = optionalText(input.first_name, 'first_name')
  if (!firstName.ok) return firstName
  const lastName = optionalText(input.last_name, 'last_name')
  if (!lastName.ok) return lastName
  if (
    input.is_financial_advisor !== undefined &&
    typeof input.is_financial_advisor !== 'boolean'
  ) {
    return { ok: false, error: 'is_financial_advisor must be a boolean' }
  }

  return {
    ok: true,
    value: {
      first_name: firstName.value,
      last_name: lastName.value,
      is_financial_advisor: input.is_financial_advisor as boolean | undefined,
    },
  }
}
