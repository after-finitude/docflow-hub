import type { DocumentListPage } from '@docflow/shared'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { readSession } from '@/lib/session'
import { InboxClient } from './inbox-client'
import { LogoutButton } from './logout-button'

export default async function InboxPage() {
  const session = await readSession()
  if (session.status === 'anonymous') redirect('/login')

  if (session.status === 'unavailable') {
    // Отдельный экран, а не редирект на форму входа: сессия может быть
    // полностью валидной, недоступен лишь бэкенд.
    return <Unavailable />
  }

  let initial: DocumentListPage
  try {
    const response = await apiFetch('/documents?page=1')
    if (!response.ok) return <Unavailable />
    initial = (await response.json()) as DocumentListPage
  } catch {
    return <Unavailable />
  }

  const { user } = session

  return (
    <main className="mx-auto max-w-7xl p-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Document Inbox</h1>
          <p className="text-sm text-neutral-500">
            {user.login} · {user.role === 'admin' ? 'администратор' : 'оператор'}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/runs" className="text-sm underline underline-offset-2">
            Execution Log
          </Link>
          <LogoutButton />
        </div>
      </header>

      <InboxClient initial={initial} />
    </main>
  )
}

function Unavailable() {
  return (
    <main className="mx-auto max-w-6xl p-8">
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-12 text-center">
        <h1 className="text-lg font-semibold">Сервис недоступен</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Не удалось связаться с API. Обновите страницу через несколько секунд.
        </p>
      </div>
    </main>
  )
}
