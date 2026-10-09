import { parsePhoneNumber } from 'libphonenumber-js'

// The only characters a phone value may contain besides an extension marker.
// Anything else (letters, "call me at", "ask for Pat") means the value is
// prose, not a number, and prose is never a match key.
const PHONE_CHARACTERS = /^[0-9\s+\-().\/]+$/

// A trailing extension in the common spellings: ";ext=5", "ext 5", "ext. 5",
// "extension 5", "x5", "x 5".
const EXTENSION = /(?:;\s*ext\s*=\s*|[\s,]*(?:extension|ext\.?|x)\s*)(\d{1,8})\s*$/i

// Exact phone identity. The key is the E.164 number, plus `;ext=<digits>` when
// an extension is present, so a number matches only the same number with the
// same extension, or a bare number with another bare number.
//
// The value must be a valid number for its region (bare national numbers are
// read as US) and, apart from the extension, contain nothing but digits and
// phone punctuation. There is no "last 10 digits" fallback, so numbers that
// differ in area code, country code, leading digits, or extension never
// compare equal.
export function normalizePhone(phone: string): string | null {
  let base = phone.trim()
  let extension: string | null = null

  const match = EXTENSION.exec(base)
  if (match) {
    extension = match[1]
    base = base.slice(0, match.index).trim()
  }
  if (base === '' || !PHONE_CHARACTERS.test(base)) return null

  try {
    const parsed = parsePhoneNumber(base, 'US')
    if (!parsed.isValid()) return null
    const e164 = parsed.format('E.164')
    return extension === null ? e164 : `${e164};ext=${extension}`
  } catch {
    return null
  }
}
