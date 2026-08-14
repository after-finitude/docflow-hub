import type { DocumentListPage } from '@docflow/shared'
import { redirect } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { readSession } from '@/lib/session'
import { TopBar } from '../top-bar'
import { InboxClient } from './inbox-client'

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

  return (
    <>
      <TopBar user={session.user} active="inbox" />
      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl">Очередь документов</h1>
            <p className="mt-0.5 text-xs text-muted">
              Приём, распознавание и проверка — по одному экрану на документ
            </p>
          </div>
        </div>
        <InboxClient initial={initial} />
      </main>
    </>
  )
}

function Unavailable() {
  return (
    <main className="mx-auto max-w-2xl px-6 pt-[18vh]">
      <h1 className="text-xl">Сервис недоступен</h1>
      <p className="mt-2 max-w-[52ch] text-sm text-ink-2">
        Не удалось связаться с API. Очередь появится, как только он ответит — обновите страницу
        через несколько секунд.
      </p>
    </main>
  )
}
