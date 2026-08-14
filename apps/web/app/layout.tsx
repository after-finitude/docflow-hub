import type { Metadata } from 'next'
import type { ReactNode } from 'react'
// Шрифты ставятся пакетами и лежат в бандле: сборка образа не ходит
// в сеть за шрифтами, а офлайн-сборка не ломается.
import '@fontsource-variable/inter'
import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/jetbrains-mono'
import './globals.css'

export const metadata: Metadata = {
  title: 'Docflow Hub',
  description: 'Приём, распознавание и верификация документов',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
