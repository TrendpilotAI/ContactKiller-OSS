import { RESOLVABLE_FIELDS, listUnresolvedConflicts } from '@/lib/db/conflicts'
import { requireSession } from '@/lib/db/session'
import type { ConflictDto } from '@/lib/db/types'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function ConflictsPage() {
  const session = await requireSession('/conflicts')

  let conflicts: ConflictDto[] = []
  try {
    conflicts = await listUnresolvedConflicts(session.db)
  } catch (error) {
    console.error('Error fetching conflicts:', error)
  } finally {
    await session.close()
  }

  const unresolvedCount = conflicts.length

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Conflicts</h1>
            <p className="text-sm text-gray-500 mt-1">
              {unresolvedCount} unresolved conflict{unresolvedCount !== 1 ? 's' : ''}
            </p>
          </div>
          <Link
            href="/"
            className="text-blue-600 hover:text-blue-700 text-sm font-medium"
          >
            ← Back to Dashboard
          </Link>
        </div>

        {unresolvedCount === 0 ? (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
            <div className="text-4xl mb-4">✨</div>
            <p className="text-gray-600 font-medium">No conflicts to resolve</p>
            <p className="text-sm text-gray-400 mt-2">
              All your contacts are in sync
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {conflicts.map((conflict) => (
              <ConflictCard key={conflict.id} conflict={conflict} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

function ConflictCard({ conflict }: { conflict: ConflictDto }) {
  const contactName = conflict.contact
    ? `${conflict.contact.first_name || ''} ${conflict.contact.last_name || ''}`.trim() || 'Unknown'
    : 'Unknown Contact'

  // Only plain contact columns can be applied automatically; anything else
  // (for example a shared email address) is reviewed by hand and dismissed.
  const canApply = (RESOLVABLE_FIELDS as readonly string[]).includes(conflict.field)

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="font-medium text-gray-900">{contactName}</h3>
          <p className="text-sm text-gray-500">
            Conflict in <span className="font-mono">{conflict.field}</span>
          </p>
        </div>
        <span className="text-xs text-gray-400">
          {new Date(conflict.created_at).toLocaleDateString()}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">
            {conflict.source_a || 'Source A'}
          </p>
          <p className="text-sm font-medium text-gray-900">
            {conflict.value_a || '(empty)'}
          </p>
        </div>
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">
            {conflict.source_b || 'Source B'}
          </p>
          <p className="text-sm font-medium text-gray-900">
            {conflict.value_b || '(empty)'}
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        {canApply && (
          <>
            <form action={`/api/conflicts/${conflict.id}/resolve`} method="POST">
              <input type="hidden" name="choice" value="a" />
              <button
                type="submit"
                className="px-4 py-2 bg-blue-100 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-200 transition"
              >
                Keep {conflict.source_a || 'Source A'}
              </button>
            </form>
            <form action={`/api/conflicts/${conflict.id}/resolve`} method="POST">
              <input type="hidden" name="choice" value="b" />
              <button
                type="submit"
                className="px-4 py-2 bg-blue-100 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-200 transition"
              >
                Keep {conflict.source_b || 'Source B'}
              </button>
            </form>
          </>
        )}
        <form action={`/api/conflicts/${conflict.id}/resolve`} method="POST">
          <input type="hidden" name="choice" value="skip" />
          <button
            type="submit"
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200 transition"
          >
            {canApply ? 'Skip' : 'Dismiss'}
          </button>
        </form>
      </div>
    </div>
  )
}
