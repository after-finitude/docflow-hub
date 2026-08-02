import { redirect } from 'next/navigation'
import { readSession } from '@/lib/session'
import { LogoutButton } from './logout-button'

export default async function InboxPage() {
  const session = await readSession()
  if (session.status === 'anonymous') redirect('/login')

  if (session.status === 'unavailable') {
    // Именно отдельный экран, а не редирект на форму входа: сессия может быть
    // полностью валидной, недоступен лишь бэкенд.
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

  const { user } = session

  return (
    <main className="mx-auto max-w-6xl p-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Document Inbox</h1>
          <p className="text-sm text-neutral-500">
            {user.login} · {user.role === 'admin' ? 'администратор' : 'оператор'}
          </p>
        </div>
        <LogoutButton />
      </header>

      <div className="rounded-xl border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-12 text-center text-sm text-neutral-500">
        Очередь документов появится на этапе 2: загрузка, миниатюры, статусы и фильтры.
      </div>
    </main>
  )
}
