const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])

export interface SurrealConfig {
  url: string
  namespace: string
  database: string
}

export interface SurrealAdminConfig extends SurrealConfig {
  user: string
  password: string
}

type Env = Record<string, string | undefined>

function required(env: Env, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. See web/.env.local.example.`)
  }
  return value
}

function identifier(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback
  if (!IDENTIFIER.test(value)) {
    throw new Error(`${name} may only contain letters, digits, "_" and "-" (max 64 characters).`)
  }
  return value
}

export function getSurrealConfig(env: Env = process.env): SurrealConfig {
  const url = env.SURREALDB_URL?.trim() || 'http://127.0.0.1:8000'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('SURREALDB_URL must be an absolute URL such as http://127.0.0.1:8000.')
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('SURREALDB_URL must use http, https, ws, or wss.')
  }
  return {
    url,
    namespace: identifier(env, 'SURREALDB_NAMESPACE', 'contactkiller'),
    database: identifier(env, 'SURREALDB_DATABASE', 'contactkiller'),
  }
}

// Root credentials are only for provisioning (migrations, local compose). The
// web runtime never reads them.
export function getSurrealAdminConfig(env: Env = process.env): SurrealAdminConfig {
  return {
    ...getSurrealConfig(env),
    user: required(env, 'SURREALDB_ROOT_USER'),
    password: required(env, 'SURREALDB_ROOT_PASSWORD'),
  }
}

export function isSignupEnabled(env: Env = process.env): boolean {
  return env.CONTACTKILLER_ALLOW_SIGNUP?.trim().toLowerCase() === 'true'
}
