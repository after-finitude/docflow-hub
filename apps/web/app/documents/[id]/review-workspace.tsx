'use client'

import {
  CLASSIFIABLE_DOCUMENT_TYPES,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  FIELD_FILTERS,
  FIELD_FILTER_LABELS,
  REJECT_REASONS,
  REJECT_REASON_LABELS,
  type ClassifiableDocumentType,
  type DocumentDetail,
  type FieldDto,
  type FieldFilter,
  type LineItem,
  type RejectReason,
} from '@docflow/shared'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { DocumentViewer, type SourceHighlight } from './document-viewer'
import { FieldCard } from './field-card'
import { LineItemsEditor } from './line-items-editor'

const DEFAULT_THRESHOLD = 0.8

export function ReviewWorkspace({ initial }: { initial: DocumentDetail }) {
  const router = useRouter()
  const [document, setDocument] = useState(initial)
  const [filter, setFilter] = useState<FieldFilter>('all')
  const [activeField, setActiveField] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)

  const threshold = document.thresholds?.criticalFieldConfidence ?? DEFAULT_THRESHOLD
  // Документ в обработке или уже выгружен не редактируется.
  const readOnly = document.status === 'processing' || document.status === 'exported'

  const issuesByField = useMemo(() => {
    const map = new Map<string, DocumentDetail['issues']>()
    for (const issue of document.issues) {
      if (!issue.fieldName || issue.resolvedAt) continue
      map.set(issue.fieldName, [...(map.get(issue.fieldName) ?? []), issue])
    }
    return map
  }, [document.issues])

  const documentIssues = document.issues.filter((issue) => !issue.fieldName && !issue.resolvedAt)

  /** Порядок: blocking → ниже порога → остальные (ТЗ 5.2). */
  const orderedFields = useMemo(() => {
    const weight = (field: FieldDto) => {
      if (issuesByField.get(field.name)?.some((issue) => issue.severity === 'blocking')) return 0
      if ((field.confidence ?? 0) < threshold) return 1
      return 2
    }
    return document.fields
      .filter((field) => field.valueType !== 'array')
      .toSorted((a, b) => weight(a) - weight(b))
  }, [document.fields, issuesByField, threshold])

  const visibleFields = orderedFields.filter((field) => {
    switch (filter) {
      case 'missing':
        return field.rawValue === null
      case 'low_confidence':
        return (field.confidence ?? 0) < threshold
      case 'invalid':
        return (issuesByField.get(field.name)?.length ?? 0) > 0
      default:
        return true
    }
  })

  const lineItemsField = document.fields.find((field) => field.valueType === 'array')

  const highlights: SourceHighlight[] = document.fields
    .filter((field) => field.sourceFound && field.sourceBbox && field.sourcePage)
    .map((field) => ({ fieldName: field.name, page: field.sourcePage!, bbox: field.sourceBbox! }))

  async function call(path: string, init: RequestInit): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
      })
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { message?: string } | null
        setError(detail?.message ?? `Ошибка ${response.status}`)
        return false
      }
      // Каждый ответ — актуальный документ с обновлёнными проблемами
      // и доступностью Approve (ТЗ 5.2).
      setDocument((await response.json()) as DocumentDetail)
      return true
    } catch {
      setError('Сервис недоступен')
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveField = (name: string) => async (value: string | null) => {
    await call(`/api/documents/${document.id}/fields/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ value }),
    })
  }

  async function saveLineItems(items: LineItem[]) {
    if (!lineItemsField) return
    await call(`/api/documents/${document.id}/fields/${lineItemsField.name}`, {
      method: 'PATCH',
      body: JSON.stringify({ value: items }),
    })
  }

  async function changeType(type: ClassifiableDocumentType) {
    if (
      await call(`/api/documents/${document.id}/type`, {
        method: 'POST',
        body: JSON.stringify({ type }),
      })
    ) {
      // Извлечение перезапускается в фоне — список полей появится после него.
      router.refresh()
    }
  }

  async function reject(reason: RejectReason, comment: string) {
    if (
      await call(`/api/documents/${document.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason, comment: comment || undefined }),
      })
    ) {
      setRejecting(false)
    }
  }

  return (
    <main className="flex h-screen flex-col p-6">
      <header className="mb-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Link href="/inbox" className="text-xs text-neutral-500 underline hover:text-neutral-800">
            ← К очереди
          </Link>
          <h1 className="truncate text-lg font-semibold">{document.originalFilename}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-sm">
          <span className="rounded bg-neutral-100 px-2 py-1 text-xs">
            {DOCUMENT_STATUS_LABELS[document.status]}
          </span>
          {document.blockingIssues > 0 && (
            <span className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
              блокирующих: {document.blockingIssues}
            </span>
          )}
          {document.warningIssues > 0 && (
            <span className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
              предупреждений: {document.warningIssues}
            </span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex min-w-0 basis-[55%] flex-col">
          {document.pageCount ? (
            <DocumentViewer
              documentId={document.id}
              pageCount={document.pageCount}
              highlights={highlights}
              activeField={activeField}
              onSelectField={setActiveField}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-[var(--color-border-subtle)] text-sm text-neutral-500">
              Документ ещё не подготовлен
            </div>
          )}
        </section>

        <section className="flex min-w-0 basis-[45%] flex-col overflow-y-auto pr-1">
          <div className="mb-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
            <label className="text-xs text-neutral-500">
              Тип документа
              <select
                className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5 text-sm"
                value={document.documentType ?? 'unknown'}
                disabled={busy || readOnly}
                onChange={(event) =>
                  void changeType(event.target.value as ClassifiableDocumentType)
                }
              >
                {document.documentType === 'unknown' || !document.documentType ? (
                  <option value="unknown">{DOCUMENT_TYPE_LABELS.unknown}</option>
                ) : null}
                {CLASSIFIABLE_DOCUMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {DOCUMENT_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1 text-xs text-neutral-500">
              Смена типа перезапускает извлечение по новой схеме
            </p>

            {document.statusReason && (
              <p className="mt-3 text-xs text-neutral-600">{document.statusReason}</p>
            )}

            {documentIssues.map((issue) => (
              <p key={issue.id} className="mt-2 text-xs text-amber-700">
                {issue.message}
              </p>
            ))}

            {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!document.canApprove || busy}
                title={
                  document.blockingIssues > 0 ? 'Есть нерешённые блокирующие ошибки' : undefined
                }
                onClick={() =>
                  void call(`/api/documents/${document.id}/approve`, { method: 'POST' })
                }
                className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white disabled:opacity-40"
              >
                Подтвердить
              </button>
              <button
                type="button"
                disabled={busy || readOnly}
                onClick={() => setRejecting(true)}
                className="rounded-md border border-[var(--color-border-subtle)] px-4 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-40"
              >
                Отклонить
              </button>
              <button
                type="button"
                disabled={busy || document.status === 'processing'}
                onClick={() =>
                  void call(`/api/documents/${document.id}/reprocess`, { method: 'POST' }).then(
                    () => router.refresh(),
                  )
                }
                className="rounded-md border border-[var(--color-border-subtle)] px-4 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-40"
              >
                Переобработать
              </button>
            </div>

            {rejecting && <RejectForm onCancel={() => setRejecting(false)} onSubmit={reject} />}
          </div>

          <div className="mb-3 flex flex-wrap gap-1">
            {FIELD_FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFilter(option)}
                className={`rounded-md px-2 py-1 text-xs ${
                  filter === option
                    ? 'bg-neutral-900 text-white'
                    : 'border border-[var(--color-border-subtle)] hover:bg-neutral-100'
                }`}
              >
                {FIELD_FILTER_LABELS[option]}
              </button>
            ))}
          </div>

          <div className="space-y-3">
            {visibleFields.length === 0 && (
              <p className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-6 text-center text-sm text-neutral-500">
                {document.fields.length === 0
                  ? 'Поля появятся после извлечения'
                  : 'Под фильтр ничего не подходит'}
              </p>
            )}
            {visibleFields.map((field) => (
              <FieldCard
                key={field.name}
                field={field}
                issues={issuesByField.get(field.name) ?? []}
                threshold={threshold}
                disabled={busy || readOnly}
                isActive={activeField === field.name}
                onFocusSource={() => setActiveField(field.name)}
                onSave={saveField(field.name)}
              />
            ))}

            {lineItemsField && (
              <LineItemsEditor
                key={lineItemsField.rawValue ?? 'empty'}
                value={parseLineItems(lineItemsField)}
                disabled={busy || readOnly}
                onSave={saveLineItems}
              />
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

function RejectForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void
  onSubmit: (reason: RejectReason, comment: string) => Promise<void>
}) {
  const [reason, setReason] = useState<RejectReason>(REJECT_REASONS[0])
  const [comment, setComment] = useState('')

  return (
    <div className="mt-4 rounded-md border border-[var(--color-border-subtle)] p-3">
      <label className="text-xs text-neutral-500">
        Причина отклонения
        <select
          className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5 text-sm"
          value={reason}
          onChange={(event) => setReason(event.target.value as RejectReason)}
        >
          {REJECT_REASONS.map((option) => (
            <option key={option} value={option}>
              {REJECT_REASON_LABELS[option]}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="mt-2 w-full rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5 text-sm"
        rows={2}
        placeholder="Комментарий (необязательно)"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void onSubmit(reason, comment)}
          className="rounded-md bg-red-600 px-3 py-1 text-xs text-white"
        >
          Отклонить документ
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-xs"
        >
          Отмена
        </button>
      </div>
    </div>
  )
}

function parseLineItems(field: FieldDto): LineItem[] {
  if (Array.isArray(field.normalizedValue)) return field.normalizedValue as LineItem[]
  return []
}
