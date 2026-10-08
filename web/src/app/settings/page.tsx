'use client'

import Link from 'next/link'
import { useEffect, useState, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { FA_EMAIL_DOMAINS } from '@/lib/fa-detection'

interface GoogleStatus {
  connected: boolean
  connectedAt?: string
  needsReauth?: boolean
}

interface SyncResult {
  success: boolean
  imported?: number
  updated?: number
  duplicates?: number
  total?: number
  error?: string
}

// Wrapper component to handle Suspense boundary for useSearchParams
export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsLoading />}>
      <SettingsContent />
    </Suspense>
  )
}

function SettingsLoading() {
  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>
        <div className="animate-pulse space-y-4">
          <div className="h-32 bg-gray-200 rounded-lg"></div>
          <div className="h-32 bg-gray-200 rounded-lg"></div>
        </div>
      </div>
    </main>
  )
}

function SettingsContent() {
  const searchParams = useSearchParams()
  const [googleStatus, setGoogleStatus] = useState<GoogleStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<SyncResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Show success/error from OAuth redirect
  const googleConnected = searchParams.get('google') === 'connected'
  const error = searchParams.get('error')

  // Check Google connection status on mount
  useEffect(() => {
    checkGoogleStatus()
  }, [googleConnected])

  async function checkGoogleStatus() {
    try {
      const res = await fetch('/api/sync/google')
      if (res.status === 401) {
        window.location.assign('/login?next=/settings')
        return
      }
      if (res.ok) {
        const data = await res.json()
        setGoogleStatus(data)
      }
    } catch (err) {
      console.error('Failed to check Google status:', err)
    }
  }

  async function handleGoogleSync() {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/sync/google', { method: 'POST' })
      const data = await res.json()
      setSyncResult(data)
    } catch {
      setSyncResult({ success: false, error: 'Sync failed' })
    }
    setSyncing(false)
  }

  async function handleICloudImport(file: File) {
    setImporting(true)
    setImportResult(null)
    try {
      const formData = new FormData()
      formData.append('vcf', file)
      const res = await fetch('/api/import/icloud', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()
      setImportResult(data)
    } catch {
      setImportResult({ success: false, error: 'Import failed' })
    }
    setImporting(false)
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) {
      handleICloudImport(file)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <Link
            href="/"
            className="text-blue-600 hover:text-blue-700 text-sm font-medium"
          >
            ← Back to Dashboard
          </Link>
        </div>

        {/* Success/Error Messages */}
        {googleConnected && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
            <p className="text-green-800 font-medium">Google account connected successfully!</p>
            <p className="text-green-600 text-sm mt-1">Click &quot;Sync Now&quot; to import your contacts.</p>
          </div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <p className="text-red-800 font-medium">Connection failed</p>
            <p className="text-red-600 text-sm mt-1">{error}</p>
          </div>
        )}

        {/* Platform Connections */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Connected Platforms
          </h2>
          <div className="space-y-4">
            {/* Google Contacts */}
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <span className="text-2xl">🔴</span>
                <div>
                  <p className="font-medium text-gray-900">Google Contacts</p>
                  <p className="text-sm text-gray-500">Sync with your Google account</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {googleStatus?.connected ? (
                  <>
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
                      Connected
                    </span>
                    <button
                      onClick={handleGoogleSync}
                      disabled={syncing}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition disabled:opacity-50"
                    >
                      {syncing ? 'Syncing...' : 'Sync Now'}
                    </button>
                  </>
                ) : googleStatus?.needsReauth ? (
                  <a
                    href="/api/auth/google"
                    className="px-4 py-2 bg-yellow-600 text-white rounded-lg text-sm font-medium hover:bg-yellow-700 transition"
                  >
                    Reconnect
                  </a>
                ) : (
                  <a
                    href="/api/auth/google"
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition"
                  >
                    Connect
                  </a>
                )}
              </div>
            </div>

            {/* Sync Result */}
            {syncResult && (
              <div className={`p-3 rounded-lg ${syncResult.success ? 'bg-green-50' : 'bg-red-50'}`}>
                {syncResult.success ? (
                  <p className="text-green-800 text-sm">
                    Synced successfully! Imported: {syncResult.imported}, Updated: {syncResult.updated}
                  </p>
                ) : (
                  <p className="text-red-800 text-sm">{syncResult.error}</p>
                )}
              </div>
            )}

            {/* iCloud */}
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <span className="text-2xl">🔵</span>
                <div>
                  <p className="font-medium text-gray-900">iCloud</p>
                  <p className="text-sm text-gray-500">Import via vCard export from iCloud.com</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".vcf,.vcard"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition disabled:opacity-50"
                >
                  {importing ? 'Importing...' : 'Import .vcf'}
                </button>
              </div>
            </div>

            {/* Import Result */}
            {importResult && (
              <div className={`p-3 rounded-lg ${importResult.success ? 'bg-green-50' : 'bg-red-50'}`}>
                {importResult.success ? (
                  <p className="text-green-800 text-sm">
                    Imported {importResult.imported} of {importResult.total} contacts
                    {importResult.duplicates ? ` (${importResult.duplicates} duplicates skipped)` : ''}
                  </p>
                ) : (
                  <p className="text-red-800 text-sm">{importResult.error}</p>
                )}
              </div>
            )}

            {/* Other platforms */}
            <PlatformConnection
              name="Contacts+"
              icon="🟣"
              status="not_connected"
              description="No adapter available"
            />
            <PlatformConnection
              name="WhatsApp"
              icon="🟢"
              status="not_connected"
              description="Evidence source only; no importer or API"
            />
          </div>
        </section>

        {/* iCloud Export Instructions */}
        <section className="bg-blue-50 rounded-lg border border-blue-200 p-6 mb-6">
          <h2 className="text-lg font-semibold text-blue-900 mb-2">
            How to Export iCloud Contacts
          </h2>
          <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800">
            <li>Go to <a href="https://icloud.com/contacts" target="_blank" rel="noopener noreferrer" className="underline">icloud.com/contacts</a></li>
            <li>Select all contacts (Cmd+A on Mac, Ctrl+A on Windows)</li>
            <li>Click the gear icon ⚙️ in the bottom left</li>
            <li>Choose &quot;Export vCard...&quot;</li>
            <li>Upload the downloaded .vcf file above</li>
          </ol>
        </section>

        {/* FA Domain Configuration */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Financial Advisor Detection
          </h2>
          <p className="text-sm text-gray-600 mb-4">
            Contacts with emails from these domains will be auto-tagged as Financial Advisors
          </p>

          <div className="bg-gray-50 rounded-lg p-4 max-h-64 overflow-y-auto">
            <div className="flex flex-wrap gap-2">
              {FA_EMAIL_DOMAINS.map((domain) => (
                <span
                  key={domain}
                  className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800"
                >
                  @{domain}
                </span>
              ))}
            </div>
          </div>

          <p className="text-xs text-gray-500 mt-3">
            {FA_EMAIL_DOMAINS.length} domains configured. Edit src/lib/fa-detection.ts to add more.
          </p>
        </section>

        {/* Sync Schedule */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Sync Schedule
          </h2>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">
                Manual sync only (automatic sync coming soon)
              </p>
              <p className="text-xs text-gray-400 mt-1">
                Use the &quot;Sync Now&quot; button to import latest contacts
              </p>
            </div>
            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
              Manual
            </span>
          </div>
        </section>

        {/* Danger Zone */}
        <section className="bg-white rounded-lg shadow-sm border border-red-200 p-6">
          <h2 className="text-lg font-semibold text-red-600 mb-4">
            Danger Zone
          </h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-900">Delete all contacts</p>
                <p className="text-sm text-gray-500">
                  Remove all contacts from ContactKiller database
                </p>
              </div>
              <button className="px-4 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-medium hover:bg-red-200 transition">
                Delete All
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

function PlatformConnection({
  name,
  icon,
  status,
  description,
}: {
  name: string
  icon: string
  status: 'connected' | 'not_connected' | 'manual'
  description: string
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div className="flex items-center gap-3">
        <span className="text-2xl">{icon}</span>
        <div>
          <p className="font-medium text-gray-900">{name}</p>
          <p className="text-sm text-gray-500">{description}</p>
        </div>
      </div>
      {status === 'connected' ? (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
          Connected
        </span>
      ) : status === 'manual' ? (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
          Manual Only
        </span>
      ) : (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-600">
          Coming Soon
        </span>
      )}
    </div>
  )
}
