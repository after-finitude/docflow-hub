'use client'

import {
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  PIPELINE_UI_STEPS,
  SOURCE_TYPES,
  SOURCE_TYPE_LABELS,
  WORKFLOW_STEP_LABELS,
  type DocumentListItem,
  type DocumentListPage,
  type DocumentStatus,
  type DocumentType,
  type SourceType,
  type StreamEvent,
} from '@docflow/shared'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Uploader } from './uploader'

interface Filters {
  status: DocumentStatus | ''
  type: DocumentType | ''
  source: SourceType | ''
  receivedFrom: string
  receivedTo: string
  hasBlocking: boolean
}

const EMPTY_FILTERS: Filters = {
  status: '',
  type: '',
  source: '',
  receivedFrom: '',
  receivedTo: '',
  hasBlocking: false,
}

/** Статусы, при которых документ ещё меняется — для индикатора прогресса. */
const IN_FLIGHT: DocumentStatus[] = ['received', 'processing']

export function InboxClient({ initial }: { initial: DocumentListPage }) {
  const [data, setData] = useState(initial)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  const buildQuery = useCallback((current: Filters, page: number) => {
    const params = new URLSearchParams()
    if (current.status) params.set('status', current.status)
    if (current.type) params.set('type', current.type)
    if (current.source) params.set('source', current.source)
    if (current.receivedFrom)
      params.set('receivedFrom', new Date(current.receivedFrom).toISOString())
    if (current.receivedTo) params.set('receivedTo', new Date(current.receivedTo).toISOString())
    if (current.hasBlocking) params.set('hasBlocking', 'true')
    params.set('page', String(page))
    return params.toString()
  }, [])

  const load = useCallback(
    async (current: Filters, page = 1) => {
      try {
        const response = await fetch(`/api/documents?${buildQuery(current, page)}`)
        if (!response.ok) {
          setError('Не удалось обновить список')
          return
        }
        setData((await response.json()) as DocumentListPage)
        setError(null)
      } catch {
        setError('Сервис недоступен')
      }
    },
    [buildQuery],
  )

  /** События приходят пачками, поэтому обновление списка склеивается. */
  const scheduleReload = useCallback(() => {
    if (pending.current) return
    pending.current = setTimeout(() => {
      pending.current = null
      void load(filters)
    }, 400)
  }, [filters, load])

  useEffect(() => {
    let pollTimer: ReturnType<typeof setInterval> | null = null
    const source = new EventSource('/api/events/stream')

    source.addEventListener('open', () => setLive(true))
    source.addEventListener('message', (message) => {
      const event = JSON.parse(message.data as string) as StreamEvent
      if (event.type === 'document') scheduleReload()
    })
    // Фолбэк на polling с интервалом 5 секунд, как требует ТЗ 5.1.
    source.addEventListener('error', () => {
      setLive(false)
      source.close()
      if (!pollTimer) pollTimer = setInterval(() => void load(filters), 5000)
    })

    return () => {
      source.close()
      if (pollTimer) clearInterval(pollTimer)
      if (pending.current) clearTimeout(pending.current)
    }
  }, [filters, load, scheduleReload])

  function applyFilters(next: Filters) {
    setFilters(next)
    void load(next)
  }

  async function retry(id: string) {
    await fetch(`/api/documents/${id}/reprocess`, { method: 'POST' })
    void load(filters)
  }

  return (
    <div className="space-y-6">
      <Uploader onUploaded={() => void load(filters)} />

      <FilterBar filters={filters} onChange={applyFilters} />

      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span>
          Документов: {data.total}
          {error && <span className="ml-2 text-red-600">{error}</span>}
        </span>
        <span>{live ? 'Обновления в реальном времени' : 'Обновление опросом'}</span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-[var(--color-border-subtle)] text-left text-xs text-neutral-500">
            <tr>
              <th className="p-3 font-medium">Превью</th>
              <th className="p-3 font-medium">Название</th>
              <th className="p-3 font-medium">Источник</th>
              <th className="p-3 font-medium">Тип</th>
              <th className="p-3 font-medium">Статус</th>
              <th className="p-3 font-medium">Confidence</th>
              <th className="p-3 font-medium">Проблемы</th>
              <th className="p-3 font-medium">Получен</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr>
                <td colSpan={9} className="p-12 text-center text-sm text-neutral-500">
                  Документов нет. Загрузите файлы через область выше.
                </td>
              </tr>
            )}
            {data.items.map((item) => (
              <Row key={item.id} item={item} onRetry={retry} />
            ))}
          </tbody>
        </table>
      </div>

      {data.total > data.pageSize && (
        <Pagination data={data} onPage={(page) => void load(filters, page)} />
      )}
    </div>
  )
}

function Row({ item, onRetry }: { item: DocumentListItem; onRetry: (id: string) => void }) {
  return (
    <tr className="border-b border-[var(--color-border-subtle)] last:border-0 align-top">
      <td className="p-3">
        {item.hasThumbnail ? (
          <Link href={`/documents/${item.id}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/documents/${item.id}/thumbnail`}
              alt=""
              className="h-16 w-12 rounded border border-[var(--color-border-subtle)] object-cover"
            />
          </Link>
        ) : (
          <div className="h-16 w-12 rounded border border-dashed border-[var(--color-border-subtle)]" />
        )}
      </td>
      <td className="p-3">
        <Link
          href={`/documents/${item.id}`}
          className="font-medium underline-offset-2 hover:underline"
        >
          {item.originalFilename}
        </Link>
        <div className="text-xs text-neutral-500">{formatSize(item.sizeBytes)}</div>
        {item.duplicateOfId && (
          <div className="mt-1 text-xs text-amber-700">Дубликат уже принятого документа</div>
        )}
      </td>
      <td className="p-3 text-neutral-600">{SOURCE_TYPE_LABELS[item.sourceType]}</td>
      <td className="p-3">
        {item.documentType ? (
          <>
            <div>{DOCUMENT_TYPE_LABELS[item.documentType]}</div>
            {item.typeConfidence !== null && (
              <div className="text-xs text-neutral-500">
                {formatConfidence(item.typeConfidence)}
              </div>
            )}
          </>
        ) : (
          <span className="text-neutral-400">—</span>
        )}
      </td>
      <td className="p-3">
        <StatusCell item={item} />
      </td>
      <td className="p-3">
        {item.minCriticalConfidence === null ? (
          <span className="text-neutral-400">—</span>
        ) : (
          <ConfidenceBar value={item.minCriticalConfidence} />
        )}
      </td>
      <td className="p-3">
        {item.blockingIssues === 0 && item.warningIssues === 0 ? (
          <span className="text-neutral-400">—</span>
        ) : (
          <div className="space-y-0.5 text-xs">
            {item.blockingIssues > 0 && (
              <div className="text-red-600">блокирующих: {item.blockingIssues}</div>
            )}
            {item.warningIssues > 0 && (
              <div className="text-amber-700">предупреждений: {item.warningIssues}</div>
            )}
          </div>
        )}
      </td>
      <td className="p-3 text-xs text-neutral-600">{formatDate(item.receivedAt)}</td>
      <td className="p-3 text-right">
        {item.status === 'failed' && (
          <button
            type="button"
            onClick={() => onRetry(item.id)}
            className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-xs hover:bg-neutral-100"
          >
            Повторить
          </button>
        )}
      </td>
    </tr>
  )
}

function StatusCell({ item }: { item: DocumentListItem }) {
  const tone: Record<DocumentStatus, string> = {
    received: 'bg-neutral-100 text-neutral-700',
    processing: 'bg-blue-50 text-blue-700',
    needs_review: 'bg-amber-50 text-amber-800',
    approved: 'bg-green-50 text-green-700',
    exported: 'bg-green-100 text-green-800',
    failed: 'bg-red-50 text-red-700',
    rejected: 'bg-red-100 text-red-800',
  }

  return (
    <div className="space-y-1">
      <span className={`inline-block rounded px-2 py-0.5 text-xs ${tone[item.status]}`}>
        {DOCUMENT_STATUS_LABELS[item.status]}
      </span>
      {item.statusReason && (
        <div className="max-w-[220px] text-xs text-neutral-600">{item.statusReason}</div>
      )}
      {IN_FLIGHT.includes(item.status) && <StepProgress current={item.currentStep} />}
    </div>
  )
}

/** Прогресс по этапам обработки, ТЗ 5.1. Этапы 3–5 наполнят его реальными шагами. */
function StepProgress({ current }: { current: DocumentListItem['currentStep'] }) {
  const index = current ? PIPELINE_UI_STEPS.indexOf(current) : -1
  return (
    <div className="flex gap-1">
      {PIPELINE_UI_STEPS.map((step, position) => (
        <span
          key={step}
          title={WORKFLOW_STEP_LABELS[step]}
          className={`h-1 w-6 rounded ${position <= index ? 'bg-blue-500' : 'bg-neutral-200'}`}
        />
      ))}
    </div>
  )
}

function ConfidenceBar({ value }: { value: number }) {
  const percent = Math.round(value * 100)
  const color = value < 0.6 ? 'bg-red-500' : value < 0.8 ? 'bg-amber-500' : 'bg-green-500'
  return (
    <div className="w-24">
      <div className="text-xs">{value.toFixed(2)}</div>
      <div className="mt-1 h-1.5 rounded bg-neutral-200">
        <div className={`h-1.5 rounded ${color}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function FilterBar({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  const field =
    'rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-sm'

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-xs text-neutral-500">
        Статус
        <select
          className={`mt-1 block ${field}`}
          value={filters.status}
          onChange={(event) =>
            onChange({ ...filters, status: event.target.value as Filters['status'] })
          }
        >
          <option value="">все</option>
          {DOCUMENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {DOCUMENT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs text-neutral-500">
        Тип
        <select
          className={`mt-1 block ${field}`}
          value={filters.type}
          onChange={(event) =>
            onChange({ ...filters, type: event.target.value as Filters['type'] })
          }
        >
          <option value="">все</option>
          {DOCUMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {DOCUMENT_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs text-neutral-500">
        Источник
        <select
          className={`mt-1 block ${field}`}
          value={filters.source}
          onChange={(event) =>
            onChange({ ...filters, source: event.target.value as Filters['source'] })
          }
        >
          <option value="">все</option>
          {SOURCE_TYPES.map((source) => (
            <option key={source} value={source}>
              {SOURCE_TYPE_LABELS[source]}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs text-neutral-500">
        Получен с
        <input
          type="date"
          className={`mt-1 block ${field}`}
          value={filters.receivedFrom}
          onChange={(event) => onChange({ ...filters, receivedFrom: event.target.value })}
        />
      </label>

      <label className="text-xs text-neutral-500">
        по
        <input
          type="date"
          className={`mt-1 block ${field}`}
          value={filters.receivedTo}
          onChange={(event) => onChange({ ...filters, receivedTo: event.target.value })}
        />
      </label>

      <label className="flex items-center gap-2 pb-2 text-xs text-neutral-600">
        <input
          type="checkbox"
          checked={filters.hasBlocking}
          onChange={(event) => onChange({ ...filters, hasBlocking: event.target.checked })}
        />
        только с блокирующими ошибками
      </label>

      <button
        type="button"
        onClick={() => onChange(EMPTY_FILTERS)}
        className="pb-2 text-xs text-neutral-500 underline hover:text-neutral-800"
      >
        сбросить
      </button>
    </div>
  )
}

function Pagination({ data, onPage }: { data: DocumentListPage; onPage: (page: number) => void }) {
  const pages = Math.ceil(data.total / data.pageSize)
  return (
    <div className="flex items-center justify-center gap-2 text-sm">
      <button
        type="button"
        disabled={data.page <= 1}
        onClick={() => onPage(data.page - 1)}
        className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 disabled:opacity-40"
      >
        Назад
      </button>
      <span className="text-xs text-neutral-500">
        {data.page} из {pages}
      </span>
      <button
        type="button"
        disabled={data.page >= pages}
        onClick={() => onPage(data.page + 1)}
        className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 disabled:opacity-40"
      >
        Вперёд
      </button>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

function formatConfidence(value: number): string {
  return `уверенность ${value.toFixed(2)}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
}
