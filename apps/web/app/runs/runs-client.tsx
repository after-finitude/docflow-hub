'use client'

import {
  ALL_WORKFLOW_STEPS,
  DOCUMENT_STATUS_LABELS,
  WORKFLOW_STATE_LABELS,
  WORKFLOW_STEP_LABELS,
  type RunListItem,
  type RunListPage,
  type WorkflowState,
  type WorkflowStep,
} from '@docflow/shared'
import Link from 'next/link'
import { useCallback, useState } from 'react'

interface Filters {
  onlyErrors: boolean
  step: WorkflowStep | ''
  from: string
  to: string
}

const EMPTY_FILTERS: Filters = { onlyErrors: false, step: '', from: '', to: '' }

/** Этапы, которые повторяются из журнала: приём и экспорт повторяются иначе. */
const RETRYABLE: WorkflowStep[] = [
  'preprocess',
  'ocr',
  'classification',
  'extraction',
  'validation',
]

export function RunsClient({ initial }: { initial: RunListPage }) {
  const [data, setData] = useState(initial)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (current: Filters, page = 1) => {
    const params = new URLSearchParams()
    if (current.onlyErrors) params.set('onlyErrors', 'true')
    if (current.step) params.set('step', current.step)
    if (current.from) params.set('from', new Date(current.from).toISOString())
    if (current.to) params.set('to', new Date(current.to).toISOString())
    params.set('page', String(page))

    try {
      const response = await fetch(`/api/runs?${params.toString()}`)
      if (!response.ok) {
        setError('Не удалось загрузить журнал')
        return
      }
      setData((await response.json()) as RunListPage)
      setError(null)
    } catch {
      setError('Сервис недоступен')
    }
  }, [])

  async function act(run: RunListItem, action: 'retry' | 'manual') {
    setBusy(run.id)
    try {
      const response = await fetch(`/api/runs/${run.id}/${action}`, { method: 'POST' })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null
        setError(body?.message ?? 'Действие не выполнено')
        return
      }
      setError(null)
      await load(filters, data.page)
    } finally {
      setBusy(null)
    }
  }

  function applyFilters(next: Filters) {
    setFilters(next)
    void load(next)
  }

  return (
    <div className="space-y-6">
      <FilterBar filters={filters} onChange={applyFilters} />

      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span>
          Записей: {data.total}
          {error && <span className="ml-2 text-red-600">{error}</span>}
        </span>
        <button
          type="button"
          onClick={() => void load(filters, data.page)}
          className="underline hover:text-neutral-800"
        >
          обновить
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="border-b border-[var(--color-border-subtle)] text-left text-xs text-neutral-500">
            <tr>
              <th className="p-3 font-medium">Документ</th>
              <th className="p-3 font-medium">Этап</th>
              <th className="p-3 font-medium">Статус</th>
              <th className="p-3 font-medium">Длительность</th>
              <th className="p-3 font-medium">Попыток</th>
              <th className="p-3 font-medium">Код ошибки</th>
              <th className="p-3 font-medium">correlation_id</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr>
                <td colSpan={8} className="p-12 text-center text-sm text-neutral-500">
                  Записей нет.
                </td>
              </tr>
            )}
            {data.items.map((run) => (
              <Row
                key={run.id}
                run={run}
                expanded={expanded === run.id}
                busy={busy === run.id}
                onToggle={() => setExpanded(expanded === run.id ? null : run.id)}
                onAct={act}
              />
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

function Row({
  run,
  expanded,
  busy,
  onToggle,
  onAct,
}: {
  run: RunListItem
  expanded: boolean
  busy: boolean
  onToggle: () => void
  onAct: (run: RunListItem, action: 'retry' | 'manual') => void
}) {
  const tone: Record<WorkflowState, string> = {
    pending: 'bg-neutral-100 text-neutral-700',
    running: 'bg-blue-50 text-blue-700',
    succeeded: 'bg-green-50 text-green-700',
    failed: 'bg-red-50 text-red-700',
  }

  return (
    <>
      <tr className="border-b border-[var(--color-border-subtle)] align-top last:border-0">
        <td className="p-3">
          <Link
            href={`/documents/${run.documentId}`}
            className="font-medium underline-offset-2 hover:underline"
          >
            {run.documentFilename}
          </Link>
          <div className="text-xs text-neutral-500">
            {DOCUMENT_STATUS_LABELS[run.documentStatus]}
          </div>
        </td>
        <td className="p-3">{WORKFLOW_STEP_LABELS[run.step]}</td>
        <td className="p-3">
          <span className={`inline-block rounded px-2 py-0.5 text-xs ${tone[run.state]}`}>
            {WORKFLOW_STATE_LABELS[run.state]}
          </span>
        </td>
        <td className="p-3 text-xs text-neutral-600">{formatDuration(run.durationMs)}</td>
        <td className="p-3 text-xs text-neutral-600">{run.attempts}</td>
        <td className="p-3 text-xs">
          {run.errorCode ? (
            <span className="text-red-600">{run.errorCode}</span>
          ) : (
            <span className="text-neutral-400">—</span>
          )}
        </td>
        <td className="p-3 font-mono text-[11px] text-neutral-500">{run.correlationId}</td>
        <td className="p-3 text-right">
          <button
            type="button"
            onClick={onToggle}
            className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-xs hover:bg-neutral-100"
          >
            {expanded ? 'Свернуть' : 'Подробнее'}
          </button>
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-[var(--color-border-subtle)] bg-neutral-50/60">
          <td colSpan={8} className="space-y-4 p-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Detail title="Вход этапа">
                <pre className="overflow-x-auto text-xs">
                  {JSON.stringify(
                    run.deadLetter?.payload ?? { documentId: run.documentId },
                    null,
                    2,
                  )}
                </pre>
              </Detail>
              <Detail title="Результат">
                <dl className="space-y-1 text-xs text-neutral-600">
                  <Line label="Начало" value={formatDate(run.startedAt)} />
                  <Line label="Окончание" value={formatDate(run.finishedAt)} />
                  <Line label="Очередь" value={run.deadLetter?.queue ?? '—'} />
                  <Line label="Задача" value={run.deadLetter?.jobId ?? '—'} />
                  <Line
                    label="Повтор запрошен"
                    value={run.deadLetter?.retriedAt ? formatDate(run.deadLetter.retriedAt) : '—'}
                  />
                </dl>
              </Detail>
            </div>

            {run.errorDetail && (
              <Detail title="Текст ошибки">
                <pre className="overflow-x-auto text-xs text-red-700">{run.errorDetail}</pre>
              </Detail>
            )}

            {run.deadLetter?.stack && (
              <Detail title="Стек">
                <pre className="max-h-64 overflow-auto text-[11px] text-neutral-600">
                  {run.deadLetter.stack}
                </pre>
              </Detail>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !RETRYABLE.includes(run.step)}
                onClick={() => onAct(run, 'retry')}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-40"
              >
                Повторить этап
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onAct(run, 'manual')}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-40"
              >
                В ручную обработку
              </button>
              <Link
                href={`/documents/${run.documentId}`}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs hover:bg-neutral-100"
              >
                Открыть документ
              </Link>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Detail({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 text-xs font-medium text-neutral-500">{title}</div>
      {children}
    </div>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-36 shrink-0 text-neutral-500">{label}</dt>
      <dd className="break-all">{value}</dd>
    </div>
  )
}

function FilterBar({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  const field =
    'rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-sm'

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-xs text-neutral-500">
        Этап
        <select
          className={`mt-1 block ${field}`}
          value={filters.step}
          onChange={(event) =>
            onChange({ ...filters, step: event.target.value as Filters['step'] })
          }
        >
          <option value="">все</option>
          {ALL_WORKFLOW_STEPS.map((step) => (
            <option key={step} value={step}>
              {WORKFLOW_STEP_LABELS[step]}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs text-neutral-500">
        С
        <input
          type="date"
          className={`mt-1 block ${field}`}
          value={filters.from}
          onChange={(event) => onChange({ ...filters, from: event.target.value })}
        />
      </label>

      <label className="text-xs text-neutral-500">
        по
        <input
          type="date"
          className={`mt-1 block ${field}`}
          value={filters.to}
          onChange={(event) => onChange({ ...filters, to: event.target.value })}
        />
      </label>

      <label className="flex items-center gap-2 pb-2 text-xs text-neutral-600">
        <input
          type="checkbox"
          checked={filters.onlyErrors}
          onChange={(event) => onChange({ ...filters, onlyErrors: event.target.checked })}
        />
        только ошибки
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

function Pagination({ data, onPage }: { data: RunListPage; onPage: (page: number) => void }) {
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

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} мс`
  return `${(ms / 1000).toFixed(1)} с`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' })
}
