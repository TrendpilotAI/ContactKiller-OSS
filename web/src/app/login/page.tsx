import Link from 'next/link'
import { isSignupEnabled } from '@/lib/db/config'
import { openSession } from '@/lib/db/session'
import { safeNextPath } from '@/lib/safe-redirect'
import { LoginForm } from './login-form'

export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>
}) {
  const { next } = await searchParams
  const session = await openSession().catch(() => null)
  await session?.close()

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto px-4 py-16">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">ContactKiller</h1>
        <p className="text-gray-600 mb-8">
          Sign in to the local prototype. Accounts live in your SurrealDB instance.
        </p>
        <LoginForm
          next={safeNextPath(next)}
          signedIn={session !== null}
          signupEnabled={isSignupEnabled()}
        />
        <Link href="/" className="block mt-8 text-sm text-blue-600 hover:text-blue-700">
          ← Back to Dashboard
        </Link>
      </div>
    </main>
  )
}
