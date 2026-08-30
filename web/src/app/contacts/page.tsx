import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ContactsTable } from './contacts-table'

export const dynamic = 'force-dynamic'

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; search?: string }>
}) {
  const { filter, search } = await searchParams
  const supabase = await createClient()

  let query = supabase
    .from('contacts')
    .select(`
      *,
      emails (*),
      phones (*),
      platform_links (*)
    `)
    .order('updated_at', { ascending: false })
    .limit(100)

  // Apply filter
  if (filter === 'personal') {
    query = query.eq('is_financial_advisor', false)
  } else if (filter === 'fa') {
    query = query.eq('is_financial_advisor', true)
  }

  // Apply search (simple name search)
  if (search) {
    query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%`)
  }

  const { data: contacts, error } = await query

  if (error) {
    console.error('Error fetching contacts:', error)
  }

  // Get counts
  const { count: totalCount } = await supabase
    .from('contacts')
    .select('*', { count: 'exact', head: true })

  const { count: faCount } = await supabase
    .from('contacts')
    .select('*', { count: 'exact', head: true })
    .eq('is_financial_advisor', true)

  const personalCount = (totalCount || 0) - (faCount || 0)

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Contacts</h1>
            <p className="text-sm text-gray-500 mt-1">
              {totalCount || 0} total • {personalCount} personal • {faCount || 0} financial advisors
            </p>
          </div>
          <Link
            href="/"
            className="text-blue-600 hover:text-blue-700 text-sm font-medium"
          >
            ← Back to Dashboard
          </Link>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
          <div className="flex flex-wrap gap-4 items-center">
            <form className="flex-1 min-w-[200px]">
              <input
                type="search"
                name="search"
                placeholder="Search by name..."
                defaultValue={search}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </form>
            <div className="flex gap-2">
              <FilterButton href="/contacts" active={!filter}>
                All
              </FilterButton>
              <FilterButton href="/contacts?filter=personal" active={filter === 'personal'}>
                Personal
              </FilterButton>
              <FilterButton href="/contacts?filter=fa" active={filter === 'fa'}>
                Financial Advisors
              </FilterButton>
            </div>
          </div>
        </div>

        {/* Contacts Table */}
        <ContactsTable contacts={contacts || []} />
      </div>
    </main>
  )
}

function FilterButton({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
        active
          ? 'bg-blue-600 text-white'
          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
      }`}
    >
      {children}
    </Link>
  )
}
