import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ContactKiller',
  description: 'Experimental provenance-first contact reconciliation prototype',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  )
}
