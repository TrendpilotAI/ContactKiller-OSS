import type { Db } from './client'

// The database-side sign-up switch consulted by the `account` SIGNUP clause.
// Needs a root-scope connection with the namespace and database selected.
export async function setSignupEnabled(db: Db, enabled: boolean): Promise<void> {
  await db.query('UPSERT setting:signup SET enabled = $enabled', { enabled }).collect()
}

export async function isSignupEnabledInDatabase(db: Db): Promise<boolean> {
  const [value] = await db
    .query('RETURN (SELECT VALUE enabled FROM ONLY setting:signup)')
    .collect<[boolean | undefined]>()
  return value === true
}
