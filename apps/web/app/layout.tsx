import type { Metadata } from 'next'
import type { ReactNode } from 'react'
// Fonts are installed as packages and bundled, so image builds do not fetch
// fonts from the network and offline builds keep working.
import '@fontsource-variable/inter'
import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/jetbrains-mono'
import './globals.css'

export const metadata: Metadata = {
  title: 'Docflow Hub',
  description: 'Document ingest, recognition, and verification',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
