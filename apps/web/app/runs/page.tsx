import type { RunListPage } from '@docflow/shared'
import { redirect } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { readSession } from '@/lib/session'
import { TopBar } from '../top-bar'
import { RunsClient } from './runs-client'

/** Execution Log (spec 5.3): stage history with retries for failed jobs. */
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
          <h1 className="text-xl">Execution log</h1>
          <p className="mt-0.5 text-xs text-muted">
            Processing stages: duration, attempts, errors, and failed-job retries
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
      <h1 className="text-xl">Service unavailable</h1>
      <p className="mt-2 max-w-[52ch] text-sm text-ink-2">
        Could not reach the API. Refresh the page in a few seconds.
      </p>
    </main>
  )
}
