import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Subprocess } from 'bun'
import { RecordId } from 'surrealdb'
import { connectAdmin, connectWithToken, type Db } from '@/lib/db/client'
import type { SurrealAdminConfig } from '@/lib/db/config'
import { migrate } from '@/lib/db/migrate'
import { signUp } from '@/lib/db/auth'

export function surrealBinary(): string | null {
  const configured = process.env.SURREAL_BIN
  if (configured) return existsSync(configured) ? configured : null
  const found = Bun.which('surreal')
  return found ?? null
}

// Integration tests need a SurrealDB server binary. CI installs one; locally
// they are skipped unless SURREAL_BIN (or `surreal` on PATH) is available.
export const surrealAvailable = surrealBinary() !== null
if (!surrealAvailable && process.env.CI) {
  throw new Error('CI requires a SurrealDB binary: set SURREAL_BIN or put `surreal` on PATH.')
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('No port'))
      })
    })
  })
}

export interface TestDatabase {
  config: SurrealAdminConfig
  admin: Db
  stop(): Promise<void>
}

// Starts an in-memory server, applies the real migrations, and returns a
// root-scope handle for assertions about what is stored.
export async function startTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const binary = surrealBinary()
  if (!binary) throw new Error('SurrealDB binary not available')

  const port = await freePort()
  const password = randomBytes(16).toString('hex')
  const server: Subprocess = Bun.spawn(
    [binary, 'start', '--bind', `127.0.0.1:${port}`, '--log', 'warn', 'memory'],
    {
      env: { ...process.env, SURREAL_USER: 'root', SURREAL_PASS: password },
      stdout: 'ignore',
      stderr: 'ignore',
    }
  )

  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      if ((await fetch(`${url}/health`)).ok) break
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      server.kill()
      throw new Error('SurrealDB test server did not become ready')
    }
    await Bun.sleep(50)
  }

  const config: SurrealAdminConfig = {
    url,
    namespace: 'ck_test',
    database: 'ck_test',
    user: 'root',
    password,
  }
  const admin = await connectAdmin(config)
  if (options.migrate !== false) await migrate(admin, config)
  await admin.use({ namespace: config.namespace, database: config.database })

  return {
    config,
    admin,
    async stop() {
      await admin.close().catch(() => undefined)
      server.kill()
      await server.exited
    },
  }
}

export interface TestUser {
  email: string
  token: string
  db: Db
  id: RecordId
}

let counter = 0

export async function createTestUser(database: TestDatabase, label = 'user'): Promise<TestUser> {
  counter += 1
  const email = `${label}-${counter}@example.com`
  const token = await signUp(database.config, email, 'correct-horse-battery-1')
  const db = await connectWithToken(database.config, token)
  const [id] = await db.query('RETURN $auth').collect<[RecordId]>()
  return { email, token, db, id }
}
