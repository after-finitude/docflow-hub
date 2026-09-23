'use client'

import {
  ALL_WORKFLOW_STEPS,
  DOCUMENT_STATUS_LABELS,
  canPerform,
  WORKFLOW_STATE_LABELS,
  WORKFLOW_STEP_LABELS,
  type RunListItem,
  type RunListPage,
  type WorkflowState,
  type WorkflowStep,
} from '@docflow/shared'
import { apiCall } from '@/lib/client'
import Link from 'next/link'
import { useCallback, useState } from 'react'

interface Filters {
  onlyErrors: boolean
  step: WorkflowStep | ''
  from: string
  to: string
}

const EMPTY_FILTERS: Filters = { onlyErrors: false, step: '', from: '', to: '' }

/** Stages retried from the log; ingest and export use different retry paths. */
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

    const result = await apiCall<RunListPage>(
      `/runs?${params.toString()}`,
      {},
      'Could not load the execution log',
    )
    if (!result.ok) {
      setError(result.message)
      return
    }
    setData(result.data)
    setError(null)
  }, [])

  async function act(run: RunListItem, action: 'retry' | 'manual') {
    setBusy(run.id)
    try {
      const result = await apiCall(`/runs/${run.id}/${action}`, { method: 'POST' }, 'Action failed')
      if (!result.ok) {
        setError(result.message)
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

      <div className="flex items-center justify-between gap-4 text-xs">
        <span className="text-muted">
          Entries: <span className="mono text-ink">{data.total}</span>
          {error && <span className="ml-2 text-danger">{error}</span>}
        </span>
        <button
          type="button"
          onClick={() => void load(filters, data.page)}
          className="link text-xs"
        >
          refresh
        </button>
      </div>

      <div className="panel overflow-x-auto">
        <table className="table min-w-[1040px]">
          <thead>
            <tr>
              <th>Document</th>
              <th className="w-36">Stage</th>
              <th className="w-32">State</th>
              <th className="w-28">Duration</th>
              <th className="w-20">Attempts</th>
              <th className="w-44">Error code</th>
              <th className="w-72">correlation_id</th>
              <th className="w-28" />
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr>
                <td colSpan={8} className="py-16 text-center">
                  <p className="text-sm">No entries</p>
                  <p className="mt-1 text-xs text-muted">
                    Entries appear as documents are processed
                  </p>
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
    pending: 'chip--neutral',
    running: 'chip--live',
    succeeded: 'chip--ok',
    failed: 'chip--danger',
  }

  return (
    <>
      <tr className="align-middle">
        <td>
          <Link href={`/documents/${run.documentId}`} className="font-medium hover:text-accent">
            {run.documentFilename}
          </Link>
          <div className="mt-0.5 text-2xs text-muted">
            {DOCUMENT_STATUS_LABELS[run.documentStatus]}
          </div>
        </td>
        <td>{WORKFLOW_STEP_LABELS[run.step]}</td>
        <td>
          <span className={`chip ${tone[run.state]}`}>{WORKFLOW_STATE_LABELS[run.state]}</span>
        </td>
        <td className="mono text-xs text-ink-2">{formatDuration(run.durationMs)}</td>
        <td className="mono text-xs text-ink-2">{run.attempts}</td>
        <td className="mono text-xs">
          {run.errorCode ? (
            <span className="text-danger">{run.errorCode}</span>
          ) : (
            <span className="text-rule-2">—</span>
          )}
        </td>
        <td className="mono truncate text-2xs text-muted" title={run.correlationId}>
          {run.correlationId}
        </td>
        <td className="text-right">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="btn btn--ghost btn--sm"
          >
            {expanded ? 'Collapse' : 'Details'}
          </button>
        </td>
      </tr>

      {expanded && (
        <tr className="bg-paper-2">
          <td colSpan={8} className="space-y-3 p-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Detail title="Stage input">
                <pre className="mono overflow-x-auto text-2xs leading-relaxed">
                  {JSON.stringify(
                    run.deadLetter?.payload ?? { documentId: run.documentId },
                    null,
                    2,
                  )}
                </pre>
              </Detail>
              <Detail title="Result">
                <dl className="space-y-1 text-xs text-ink-2">
                  <Line label="Started" value={formatDate(run.startedAt)} />
                  <Line label="Finished" value={formatDate(run.finishedAt)} />
                  <Line label="Queue" value={run.deadLetter?.queue ?? '—'} />
                  <Line label="Job" value={run.deadLetter?.jobId ?? '—'} />
                  <Line
                    label="Retry requested"
                    value={run.deadLetter?.retriedAt ? formatDate(run.deadLetter.retriedAt) : '—'}
                  />
                </dl>
              </Detail>
            </div>

            {run.errorDetail && (
              <Detail title="Error message">
                <pre className="mono overflow-x-auto text-xs text-danger">{run.errorDetail}</pre>
              </Detail>
            )}

            {run.deadLetter?.stack && (
              <Detail title="Stack trace">
                <pre className="mono max-h-64 overflow-auto text-2xs leading-relaxed text-muted">
                  {run.deadLetter.stack}
                </pre>
              </Detail>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={
                  busy ||
                  !RETRYABLE.includes(run.step) ||
                  !canPerform('retryRun', run.documentStatus)
                }
                title={
                  RETRYABLE.includes(run.step)
                    ? undefined
                    : 'Ingest and export use different retry paths; see the runbook'
                }
                onClick={() => onAct(run, 'retry')}
                className="btn btn--primary btn--sm"
              >
                {busy ? 'Queueing…' : 'Retry stage'}
              </button>
              <button
                type="button"
                disabled={busy || !canPerform('sendToManual', run.documentStatus)}
                onClick={() => onAct(run, 'manual')}
                className="btn btn--ghost btn--sm"
              >
                Send to manual review
              </button>
              <Link href={`/documents/${run.documentId}`} className="btn btn--ghost btn--sm">
                Open document
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
    <div className="panel p-3">
      <div className="mono mb-2 text-2xs tracking-[0.06em] text-muted uppercase">{title}</div>
      {children}
    </div>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-36 shrink-0 text-muted">{label}</dt>
      <dd className="mono mono--wrap">{value}</dd>
    </div>
  )
}

function FilterBar({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="label mb-1">Stage</span>
        <select
          className="field w-44"
          value={filters.step}
          onChange={(event) =>
            onChange({ ...filters, step: event.target.value as Filters['step'] })
          }
        >
          <option value="">all</option>
          {ALL_WORKFLOW_STEPS.map((step) => (
            <option key={step} value={step}>
              {WORKFLOW_STEP_LABELS[step]}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="label mb-1">From</span>
        <input
          type="date"
          className="field w-36"
          value={filters.from}
          onChange={(event) => onChange({ ...filters, from: event.target.value })}
        />
      </label>

      <label className="block">
        <span className="label mb-1">to</span>
        <input
          type="date"
          className="field w-36"
          value={filters.to}
          onChange={(event) => onChange({ ...filters, to: event.target.value })}
        />
      </label>

      <label className="flex h-9 shrink-0 cursor-pointer items-center gap-2 text-xs text-ink-2">
        <input
          type="checkbox"
          className="accent-accent"
          checked={filters.onlyErrors}
          onChange={(event) => onChange({ ...filters, onlyErrors: event.target.checked })}
        />
        errors only
      </label>

      <button
        type="button"
        onClick={() => onChange(EMPTY_FILTERS)}
        className="btn btn--ghost btn--sm"
      >
        Reset
      </button>
    </div>
  )
}

function Pagination({ data, onPage }: { data: RunListPage; onPage: (page: number) => void }) {
  const pages = Math.ceil(data.total / data.pageSize)
  return (
    <div className="flex items-center justify-center gap-3">
      <button
        type="button"
        disabled={data.page <= 1}
        onClick={() => onPage(data.page - 1)}
        className="btn btn--ghost btn--sm"
      >
        Previous
      </button>
      <span className="mono text-xs text-muted">
        {data.page} / {pages}
      </span>
      <button
        type="button"
        disabled={data.page >= pages}
        onClick={() => onPage(data.page + 1)}
        className="btn btn--ghost btn--sm"
      >
        Next
      </button>
    </div>
  )
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' })
}
