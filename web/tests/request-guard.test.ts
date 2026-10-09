import { describe, expect, test } from 'bun:test'
import {
  MAX_AUTH_JSON_BYTES,
  MAX_FORM_BYTES,
  MAX_JSON_BYTES,
  checkOrigin,
  guardRequest,
  readLimitedFormData,
  readLimitedJson,
  requireJson,
} from '@/lib/request-guard'

const env = { NEXT_PUBLIC_APP_URL: 'http://localhost:3000' }
const post = (headers: Record<string, string>, body = '{}') =>
  new Request('http://localhost:3000/api/x', { method: 'POST', headers, body })

describe('origin check', () => {
  test('accepts the configured origin, and Referer when Origin is absent', () => {
    expect(checkOrigin(post({ origin: 'http://localhost:3000' }), env)).toBeNull()
    expect(checkOrigin(post({ referer: 'http://localhost:3000/login?next=/x' }), env)).toBeNull()
  })

  test('rejects other origins, "null", look-alikes, and requests with neither header', async () => {
    const hostile: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: 'http://localhost:3000.evil.example' },
      { origin: 'http://localhost:3001' },
      { origin: 'https://localhost:3000' },
      { referer: 'https://evil.example/http://localhost:3000' },
      { referer: 'not a url' },
      {},
    ]
    for (const headers of hostile) {
      const response = checkOrigin(post(headers), env)
      expect(response?.status).toBe(403)
    }
  })

  test('Origin wins over a matching Referer', () => {
    const response = checkOrigin(post({ origin: 'https://evil.example', referer: 'http://localhost:3000/' }), env)
    expect(response?.status).toBe(403)
  })

  test('fails closed when the app URL is not configured', () => {
    expect(checkOrigin(post({ origin: 'http://localhost:3000' }), {})?.status).toBe(500)
  })
})

describe('content type', () => {
  test('JSON routes require application/json', () => {
    expect(requireJson(post({ 'content-type': 'application/json' }))).toBeNull()
    expect(requireJson(post({ 'content-type': 'application/json; charset=utf-8' }))).toBeNull()
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect(requireJson(post({ 'content-type': type }))?.status).toBe(415)
    }
    expect(requireJson(post({}))?.status).toBe(415)
  })

  test('guardRequest combines both checks', () => {
    const good = { origin: 'http://localhost:3000', 'content-type': 'application/json' }
    expect(guardRequest(post(good), { json: true }, env)).toBeNull()
    expect(guardRequest(post({ origin: 'http://localhost:3000' }), { json: true }, env)?.status).toBe(415)
    expect(guardRequest(post({ origin: 'http://localhost:3000' }), {}, env)).toBeNull()
    expect(guardRequest(post({ ...good, origin: 'https://evil.example' }), { json: true }, env)?.status).toBe(403)
  })
})

describe('limited form reader', () => {
  const form = (entries: Record<string, string | Blob>) => {
    const data = new FormData()
    for (const [key, value] of Object.entries(entries)) data.append(key, value)
    return data
  }

  test('parses forms within the limit', async () => {
    const request = new Request('http://localhost:3000/x', { method: 'POST', body: form({ choice: 'a' }) })
    expect((await readLimitedFormData(request, MAX_FORM_BYTES))?.get('choice')).toBe('a')

    const urlEncoded = new Request('http://localhost:3000/x', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'choice=skip',
    })
    expect((await readLimitedFormData(urlEncoded, MAX_FORM_BYTES))?.get('choice')).toBe('skip')
  })

  test('refuses bodies over the limit, declared or streamed', async () => {
    const big = new Blob(['x'.repeat(5000)])
    const declared = new Request('http://localhost:3000/x', { method: 'POST', body: form({ file: big }) })
    expect(await readLimitedFormData(declared, 1000)).toBeNull()

    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i += 1) controller.enqueue(new Uint8Array(1000))
        controller.close()
      },
    })
    const streamed = new Request('http://localhost:3000/x', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: chunks,
      duplex: 'half',
    } as RequestInit)
    expect(await readLimitedFormData(streamed, 4000)).toBeNull()
  })

  test('refuses non-form bodies', async () => {
    const json = new Request('http://localhost:3000/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(await readLimitedFormData(json, MAX_FORM_BYTES)).toBeNull()
    expect(await readLimitedFormData(new Request('http://localhost:3000/x', { method: 'POST' }), MAX_FORM_BYTES)).toBeNull()
  })
})

describe('limited JSON reader', () => {
  const jsonPost = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      duplex: 'half',
    } as RequestInit)

  const streamOf = (chunks: number, size: number) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < chunks; i += 1) controller.enqueue(new Uint8Array(size).fill(0x20))
        controller.close()
      },
    })

  test('parses JSON within the cap', async () => {
    const result = await readLimitedJson(jsonPost('{"a":[1,2,{"b":null}]}'), 1000)
    expect(result).toEqual({ ok: true, value: { a: [1, 2, { b: null }] } })
  })

  test('answers 413 from Content-Length without touching the body', async () => {
    const request = {
      headers: new Headers({ 'content-length': String(MAX_AUTH_JSON_BYTES + 1) }),
      get body(): never {
        throw new Error('body must not be read')
      },
    } as unknown as Request
    const result = await readLimitedJson(request, MAX_AUTH_JSON_BYTES)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(413)
  })

  test('answers 413 when a streamed body without Content-Length exceeds the cap', async () => {
    const result = await readLimitedJson(jsonPost(streamOf(20, 1000)), 4000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(413)
  })

  test('answers 413 when Content-Length understates the body', async () => {
    const result = await readLimitedJson(jsonPost(streamOf(20, 1000), { 'content-length': '10' }), 4000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(413)
  })

  test('a body exactly at the cap is accepted, one byte over is not', async () => {
    const exact = `"${'x'.repeat(98)}"`
    expect(exact.length).toBe(100)
    expect((await readLimitedJson(jsonPost(exact), 100)).ok).toBe(true)
    expect((await readLimitedJson(jsonPost(`${exact} `), 100)).ok).toBe(false)
  })

  test('answers 400 for malformed, empty, or non-UTF-8 JSON', async () => {
    for (const body of ['{"a":', '', 'not json', new Uint8Array([0x22, 0xff, 0xfe, 0x22])]) {
      const result = await readLimitedJson(jsonPost(body))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.response.status).toBe(400)
    }
  })

  test('the default cap is generous but bounded', async () => {
    expect(MAX_JSON_BYTES).toBeGreaterThan(MAX_AUTH_JSON_BYTES)
    const result = await readLimitedJson(jsonPost(streamOf(300, 1000)))
    expect(result.ok).toBe(false)
  })
})
