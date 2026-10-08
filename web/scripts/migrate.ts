import { connectAdmin } from '../src/lib/db/client'
import { getSurrealAdminConfig } from '../src/lib/db/config'
import { migrate, rollbackLatest } from '../src/lib/db/migrate'

const command = process.argv[2] ?? 'up'
if (command !== 'up' && command !== 'down') {
  console.error('Usage: bun scripts/migrate.ts [up|down]')
  process.exit(2)
}

const config = getSurrealAdminConfig()
const db = await connectAdmin(config)
try {
  if (command === 'up') {
    const { applied, skipped } = await migrate(db, config)
    console.log(`Applied: ${applied.length > 0 ? applied.join(', ') : 'none'}`)
    console.log(`Already applied: ${skipped.length > 0 ? skipped.join(', ') : 'none'}`)
  } else {
    const rolledBack = await rollbackLatest(db, config)
    console.log(rolledBack ? `Rolled back ${rolledBack}` : 'Nothing to roll back')
  }
} finally {
  await db.close()
}
process.exit(0)
