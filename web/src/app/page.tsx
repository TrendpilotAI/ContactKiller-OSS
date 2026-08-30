import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            ContactKiller
          </h1>
          <p className="text-xl text-gray-600 mb-8">
            Review contacts imported from Google and iCloud in one experimental workspace
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
            <DashboardCard
              title="Total Contacts"
              value="—"
              subtitle="Loading..."
            />
            <DashboardCard
              title="Personal"
              value="—"
              subtitle="Prototype classification"
            />
            <DashboardCard
              title="Financial Advisors"
              value="—"
              subtitle="Flagged for review"
            />
          </div>

          <div className="mt-12 flex justify-center gap-4">
            <Link
              href="/contacts"
              className="bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700 transition"
            >
              View Contacts
            </Link>
            <Link
              href="/settings"
              className="bg-gray-200 text-gray-800 px-6 py-3 rounded-lg font-medium hover:bg-gray-300 transition"
            >
              Connect Platforms
            </Link>
          </div>

          <div className="mt-8 text-sm text-gray-500">
            Last sync: Never | Schedule: Manual only
          </div>
        </div>
      </div>
    </main>
  )
}

function DashboardCard({
  title,
  value,
  subtitle,
}: {
  title: string
  value: string
  subtitle: string
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide">
        {title}
      </h3>
      <p className="text-3xl font-bold text-gray-900 mt-2">{value}</p>
      <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
    </div>
  )
}
