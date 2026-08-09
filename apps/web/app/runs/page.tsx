import type { RunListPage } from '@docflow/shared'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { readSession } from '@/lib/session'
import { RunsClient } from './runs-client'

/** Execution Log (ТЗ 5.3): журнал выполнения этапов с повтором упавших задач. */
export default async function RunsPage() {
  const session = await readSession()
  if (session.status === 'anonymous') redirect('/login')
  if (session.status === 'unavailable') return <Unavailable />

  let initial: RunListPage
  try {
    const response = await apiFetch('/runs?page=1')
    if (!response.ok) return <Unavailable />
    initial = (await response.json()) as RunListPage
  } catch {
    return <Unavailable />
  }

  return (
    <main className="mx-auto max-w-7xl p-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Execution Log</h1>
          <p className="text-sm text-neutral-500">Журнал выполнения этапов обработки</p>
        </div>
        <Link href="/inbox" className="text-sm underline underline-offset-2">
          К очереди документов
        </Link>
      </header>

      <RunsClient initial={initial} />
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
