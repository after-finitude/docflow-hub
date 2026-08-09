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

  return <ReviewWorkspace initial={document} />
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
