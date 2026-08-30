'use client'

import { useState } from 'react'
import type { ContactWithDetails } from '@/lib/database.types'

interface ContactsTableProps {
  contacts: ContactWithDetails[]
}

export function ContactsTable({ contacts }: ContactsTableProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedIds(newSelected)
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === contacts.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(contacts.map(c => c.id)))
    }
  }

  const handleBulkTag = async (isFA: boolean) => {
    if (selectedIds.size === 0) return

    const response = await fetch('/api/contacts/bulk-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: Array.from(selectedIds),
        is_financial_advisor: isFA,
      }),
    })

    if (response.ok) {
      window.location.reload()
    }
  }

  if (contacts.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
        <p className="text-gray-500">No contacts found</p>
        <p className="text-sm text-gray-400 mt-2">
          Connect a platform to import contacts
        </p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Bulk actions */}
      {selectedIds.size > 0 && (
        <div className="bg-blue-50 px-4 py-3 border-b border-blue-100 flex items-center gap-4">
          <span className="text-sm text-blue-700 font-medium">
            {selectedIds.size} selected
          </span>
          <button
            onClick={() => handleBulkTag(true)}
            className="text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            Mark as Financial Advisor
          </button>
          <button
            onClick={() => handleBulkTag(false)}
            className="text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            Mark as Personal
          </button>
        </div>
      )}

      <table className="w-full">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="px-4 py-3 text-left">
              <input
                type="checkbox"
                checked={selectedIds.size === contacts.length && contacts.length > 0}
                onChange={toggleSelectAll}
                className="rounded border-gray-300"
              />
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
              Name
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
              Email
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
              Phone
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
              Platforms
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
              Type
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {contacts.map((contact) => (
            <tr key={contact.id} className="hover:bg-gray-50">
              <td className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={selectedIds.has(contact.id)}
                  onChange={() => toggleSelect(contact.id)}
                  className="rounded border-gray-300"
                />
              </td>
              <td className="px-4 py-3">
                <span className="font-medium text-gray-900">
                  {contact.first_name || ''} {contact.last_name || ''}
                </span>
              </td>
              <td className="px-4 py-3 text-sm text-gray-600">
                {contact.emails?.[0]?.email || '—'}
              </td>
              <td className="px-4 py-3 text-sm text-gray-600">
                {contact.phones?.[0]?.phone || '—'}
              </td>
              <td className="px-4 py-3">
                <div className="flex gap-1">
                  {contact.platform_links?.map((link) => (
                    <PlatformBadge key={link.id} platform={link.platform} />
                  ))}
                  {(!contact.platform_links || contact.platform_links.length === 0) && (
                    <span className="text-xs text-gray-400">Local only</span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3">
                {contact.is_financial_advisor ? (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-700">
                    FA
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
                    Personal
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PlatformBadge({ platform }: { platform: string }) {
  const colors: Record<string, string> = {
    google: 'bg-red-100 text-red-700',
    icloud: 'bg-blue-100 text-blue-700',
    contactsplus: 'bg-purple-100 text-purple-700',
    whatsapp: 'bg-green-100 text-green-700',
  }

  const labels: Record<string, string> = {
    google: 'Google',
    icloud: 'iCloud',
    contactsplus: 'C+',
    whatsapp: 'WA',
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
        colors[platform] || 'bg-gray-100 text-gray-700'
      }`}
    >
      {labels[platform] || platform}
    </span>
  )
}
