import { parsePhoneNumber, type CountryCallingCode, type PhoneNumber } from 'libphonenumber-js'

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
  const { base, extension } = splitExtension(phone)
  if (base === '' || !PHONE_CHARACTERS.test(base)) return null
  return withExtension(toE164(base), extension)
}

// A provider that already knows the country (Google's `canonicalForm`) is
// better evidence than guessing "US" for a bare national number, but only for
// a value that is a phone to begin with. So the raw value is checked first,
// exactly as normalizePhone checks it (a recognised extension marker at most,
// and otherwise only digits and phone punctuation); anything normalizePhone
// would refuse as text is refused here too, whatever the canonical form says.
//
// The canonical form then decides the region: the raw number, read in the
// canonical form's country, must be that very number. If it is not, the two
// disagree and there is no key. The extension comes from the raw value, since
// canonical forms do not carry one. A canonical form that is missing or is not
// a valid international number is ignored and the raw value is parsed as US.
export function phoneKey(raw: string, canonicalForm?: string | null): string | null {
  const { base, extension } = splitExtension(raw)
  if (base === '' || !PHONE_CHARACTERS.test(base)) return null

  const canonical = canonicalForm?.trim()
  if (canonical && canonical.startsWith('+') && PHONE_CHARACTERS.test(canonical)) {
    const known = parseValid(canonical)
    if (known) {
      const asRead = parseValid(base, known.countryCallingCode)
      return asRead && asRead.format('E.164') === known.format('E.164')
        ? withExtension(known.format('E.164'), extension)
        : null
    }
  }
  return withExtension(toE164(base), extension)
}

function parseValid(number: string, defaultCallingCode?: string): PhoneNumber | null {
  try {
    const parsed = defaultCallingCode
      ? parsePhoneNumber(number, { defaultCallingCode: defaultCallingCode as CountryCallingCode })
      : parsePhoneNumber(number, 'US')
    return parsed.isValid() ? parsed : null
  } catch {
    return null
  }
}

function splitExtension(value: string): { base: string; extension: string | null } {
  const trimmed = value.trim()
  const match = EXTENSION.exec(trimmed)
  return match
    ? { base: trimmed.slice(0, match.index).trim(), extension: match[1] }
    : { base: trimmed, extension: null }
}

function withExtension(e164: string | null, extension: string | null): string | null {
  if (e164 === null) return null
  return extension === null ? e164 : `${e164};ext=${extension}`
}

function toE164(number: string): string | null {
  try {
    const parsed = parsePhoneNumber(number, 'US')
    return parsed.isValid() ? parsed.format('E.164') : null
  } catch {
    return null
  }
}
