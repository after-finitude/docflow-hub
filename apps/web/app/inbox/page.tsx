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
    // Show a separate screen instead of redirecting to login: the session may
    // be valid while only the backend is unavailable.
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
            <h1 className="text-xl">Document queue</h1>
            <p className="mt-0.5 text-xs text-muted">
              Ingest, recognition, and review — one workspace per document
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
      <h1 className="text-xl">Service unavailable</h1>
      <p className="mt-2 max-w-[52ch] text-sm text-ink-2">
        Could not reach the API. The queue will appear when it responds; refresh the page in a few
        seconds.
      </p>
    </main>
  )
}
