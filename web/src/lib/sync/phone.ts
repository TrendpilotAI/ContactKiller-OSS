import { parsePhoneNumber } from 'libphonenumber-js'

// Exact phone identity: the number must parse as a valid number. There is no
// "last 10 digits" fallback, so numbers that differ in area code, country
// code, or leading digits never compare equal.
export function normalizePhone(phone: string): string | null {
  try {
    const parsed = parsePhoneNumber(phone, 'US')
    return parsed.isValid() ? parsed.format('E.164') : null
  } catch {
    return null
  }
}
