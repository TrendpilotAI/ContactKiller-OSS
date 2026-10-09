export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_FORM_BYTES = 8 * 1024
export const MAX_AUTH_JSON_BYTES = 8 * 1024
export const MAX_PATCH_JSON_BYTES = 16 * 1024
export const MAX_JSON_BYTES = 256 * 1024

type Env = Record<string, string | undefined>

function reject(status: number, error: string): Response {
  return Response.json({ error }, { status })
}

function configuredOrigin(env: Env): string | null {
  try {
    return new URL(env.NEXT_PUBLIC_APP_URL ?? '').origin
  } catch {
    return null
  }
}

// Blocks cross-site state changes. Browsers attach Origin to every POST, PATCH
// and DELETE (Referer as a fallback); a request carrying neither is refused
// rather than trusted.
export function checkOrigin(request: Request, env: Env = process.env): Response | null {
  const expected = configuredOrigin(env)
  if (!expected) return reject(500, 'NEXT_PUBLIC_APP_URL is not configured')

  const origin = request.headers.get('origin')
  const referer = request.headers.get('referer')
  let actual: string | null = null
  if (origin !== null) {
    actual = origin
  } else if (referer !== null) {
    try {
      actual = new URL(referer).origin
    } catch {
      actual = null
    }
  }
  return actual === expected ? null : reject(403, 'Cross-origin request blocked')
}

export function requireJson(request: Request): Response | null {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  return type === 'application/json' ? null : reject(415, 'Content-Type must be application/json')
}

export function guardRequest(
  request: Request,
  options: { json?: boolean } = {},
  env: Env = process.env
): Response | null {
  return checkOrigin(request, env) ?? (options.json ? requireJson(request) : null)
}

// Reads at most `maxBytes` of the body, never buffering more than that.
// Returns null when the declared or actual size is larger.
async function readLimitedBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!request.body) return new Uint8Array(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response }

// Reads a JSON body under a hard size cap. Content-Length is checked before
// anything is read, and the stream is cut off at the cap when the header is
// absent or untruthful. 413 on overflow, 400 on malformed JSON.
export async function readLimitedJson(request: Request, maxBytes: number = MAX_JSON_BYTES): Promise<JsonBody> {
  const bytes = await readLimitedBytes(request, maxBytes)
  if (!bytes) return { ok: false, response: reject(413, `JSON body must be at most ${maxBytes} bytes`) }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  } catch {
    return { ok: false, response: reject(400, 'Request body must be valid JSON') }
  }
}

// Reads a form body under a hard size cap. Returns null when the body is
// larger or is not a form.
export async function readLimitedFormData(request: Request, maxBytes: number): Promise<FormData | null> {
  const type = request.headers.get('content-type') ?? ''
  if (!/^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(type)) return null

  const bytes = await readLimitedBytes(request, maxBytes)
  if (!bytes || bytes.byteLength === 0) return null
  try {
    return await new Response(bytes, { headers: { 'content-type': type } }).formData()
  } catch {
    return null
  }
}
