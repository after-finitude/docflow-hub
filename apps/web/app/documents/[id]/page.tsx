import type { DocumentDetail } from '@docflow/shared'
import { notFound, redirect } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { readSession } from '@/lib/session'
import { ReviewWorkspace } from './review-workspace'

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const session = await readSession()
  if (session.status === 'anonymous') redirect('/login')
  if (session.status === 'unavailable') return <Unavailable />

  let document: DocumentDetail
  try {
    const response = await apiFetch(`/documents/${id}`)
    if (response.status === 404) notFound()
    if (!response.ok) return <Unavailable />
    document = (await response.json()) as DocumentDetail
  } catch {
    return <Unavailable />
  }

  return <ReviewWorkspace key={document.id} initial={document} />
}

function Unavailable() {
  return (
    <main className="mx-auto max-w-6xl p-8">
      <div className="panel p-12 text-center">
        <h1 className="text-lg font-semibold">Service unavailable</h1>
        <p className="mt-2 text-sm text-muted">
          Could not reach the API. Refresh the page in a few seconds.
        </p>
      </div>
    </main>
  )
}
