const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/
const BASE = 'http://redirect.invalid'

// Only same-origin, path-only targets survive. The value is resolved the way a
// browser would, so tricks that the URL parser rewrites (tabs inside "//",
// "/\evil.com", "javascript:", absolute URLs) cannot smuggle in another origin.
export function safeNextPath(value: string | null | undefined, fallback = '/contacts'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || CONTROL_OR_BACKSLASH.test(value)) {
    return fallback
  }
  try {
    const resolved = new URL(value, BASE)
    if (resolved.origin !== BASE) return fallback
    const path = `${resolved.pathname}${resolved.search}`
    return path.startsWith('/') && !path.startsWith('//') ? path : fallback
  } catch {
    return fallback
  }
}
