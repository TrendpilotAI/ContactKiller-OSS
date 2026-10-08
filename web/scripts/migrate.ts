import { connectAdmin } from '../src/lib/db/client'
import { getSurrealAdminConfig, isSignupEnabled } from '../src/lib/db/config'
import { migrate, rollbackLatest } from '../src/lib/db/migrate'
import { setSignupEnabled } from '../src/lib/db/settings'

const [command = 'up', ...flags] = process.argv.slice(2)
if (command !== 'up' && command !== 'down') {
  console.error('Usage: bun scripts/migrate.ts up | down --confirm')
  process.exit(2)
}

const config = getSurrealAdminConfig()
const db = await connectAdmin(config)
try {
  if (command === 'up') {
    const { applied, skipped } = await migrate(db, config)
    console.log(`Applied: ${applied.length > 0 ? applied.join(', ') : 'none'}`)
    console.log(`Already applied: ${skipped.length > 0 ? skipped.join(', ') : 'none'}`)

    const signup = isSignupEnabled()
    await setSignupEnabled(db, signup)
    console.log(`Database sign-up: ${signup ? 'ENABLED' : 'disabled'} (CONTACTKILLER_ALLOW_SIGNUP)`)
  } else {
    const confirm =
      flags.includes('--confirm') || process.env.CONTACTKILLER_CONFIRM_ROLLBACK === 'yes'
    const rolledBack = await rollbackLatest(db, config, undefined, { confirm })
    console.log(rolledBack ? `Rolled back ${rolledBack}` : 'Nothing to roll back')
  }
} finally {
  await db.close()
}
process.exit(0)
