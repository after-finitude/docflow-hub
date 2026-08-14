import type { RunListPage } from '@docflow/shared'
import { redirect } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { readSession } from '@/lib/session'
import { TopBar } from '../top-bar'
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
    <>
      <TopBar user={session.user} active="runs" />
      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="mb-5">
          <h1 className="text-xl">Журнал выполнения</h1>
          <p className="mt-0.5 text-xs text-muted">
            Этапы обработки: длительность, попытки, ошибки и повтор упавшей задачи
          </p>
        </div>
        <RunsClient initial={initial} />
      </main>
    </>
  )
}

function Unavailable() {
  return (
    <main className="mx-auto max-w-2xl px-6 pt-[18vh]">
      <h1 className="text-xl">Сервис недоступен</h1>
      <p className="mt-2 max-w-[52ch] text-sm text-ink-2">
        Не удалось связаться с API. Обновите страницу через несколько секунд.
      </p>
    </main>
  )
}
