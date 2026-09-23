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
  isInFlight,
} from '@docflow/shared/browser'
import type {
  DocumentListItem,
  DocumentListPage,
  DocumentStatus,
  DocumentType,
  SourceType,
} from '@docflow/shared'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiCall } from '@/lib/client'
import { useStreamEvents } from '@/lib/events'
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

/** Status badge tone. Text duplicates the color so color is not the only signal. */
const STATUS_TONE: Record<DocumentStatus, string> = {
  received: 'chip--neutral',
  processing: 'chip--live',
  needs_review: 'chip--warn',
  approved: 'chip--ok',
  exported: 'chip--ok',
  failed: 'chip--danger',
  rejected: 'chip--danger',
}

export function InboxClient({ initial }: { initial: DocumentListPage }) {
  const [data, setData] = useState(initial)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [error, setError] = useState<string | null>(null)
  const [timeZone, setTimeZone] = useState('UTC')
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // The first browser render must match SSR; use local time after hydration.
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
  }, [])

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
      const result = await apiCall<DocumentListPage>(
        `/documents?${buildQuery(current, page)}`,
        {},
        'Could not refresh the list',
      )
      if (!result.ok) {
        setError(result.message)
        return
      }
      setData(result.data)
      setError(null)
    },
    [buildQuery],
  )

  /** Events arrive in batches, so list refreshes are debounced. */
  const scheduleReload = useCallback(() => {
    if (pending.current) return
    pending.current = setTimeout(() => {
      pending.current = null
      void load(filters)
    }, 400)
  }, [filters, load])

  const live = useStreamEvents((event) => {
    if (event.type === 'document') scheduleReload()
  })

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current)
    },
    [],
  )

  // Load on a filter change and when the stream goes live, which catches events
  // missed while connecting. Without the stream, poll every five seconds
  // (spec 5.1). The stream itself outlives filter changes.
  useEffect(() => {
    void load(filters)
    if (live) return
    const timer = setInterval(() => void load(filters), 5000)
    return () => clearInterval(timer)
  }, [live, filters, load])

  async function retry(id: string) {
    await apiCall(`/documents/${id}/reprocess`, { method: 'POST' })
    void load(filters)
  }

  return (
    <div className="space-y-4">
      <Uploader onUploaded={() => void load(filters)} />

      <FilterBar filters={filters} onChange={setFilters} />

      <div className="flex items-center justify-between gap-4 text-xs">
        <span className="text-muted">
          Documents: <span className="mono text-ink">{data.total}</span>
          {error && <span className="ml-2 text-danger">{error}</span>}
        </span>
        <span className="flex items-center gap-1.5 text-muted">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-ok' : 'bg-rule-2'}`}
          />
          {live ? 'Live updates' : 'Polling for updates'}
        </span>
      </div>

      <div className="panel overflow-x-auto">
        <table className="table min-w-[1040px]">
          <thead>
            <tr>
              <th className="w-14">File</th>
              <th>Name</th>
              <th className="w-28">Source</th>
              <th className="w-40">Type</th>
              <th className="w-56">Status</th>
              <th className="w-28">Confidence</th>
              <th className="w-32">Issues</th>
              <th className="w-36">Received</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr>
                <td colSpan={9} className="py-16 text-center">
                  <p className="text-sm">The queue is empty</p>
                  <p className="mt-1 text-xs text-muted">
                    Upload files above or place them in the source folder
                  </p>
                </td>
              </tr>
            )}
            {data.items.map((item) => (
              <Row key={item.id} item={item} onRetry={retry} timeZone={timeZone} />
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
  item,
  onRetry,
  timeZone,
}: {
  item: DocumentListItem
  onRetry: (id: string) => void
  timeZone: string
}) {
  return (
    <tr className="align-middle">
      <td>
        {item.hasThumbnail ? (
          <Link href={`/documents/${item.id}`} tabIndex={-1} aria-hidden>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/documents/${item.id}/thumbnail`}
              alt=""
              className="h-11 w-8 rounded-[3px] border border-rule object-cover"
            />
          </Link>
        ) : (
          <div className="h-11 w-8 rounded-[3px] border border-dashed border-rule-2" />
        )}
      </td>
      <td>
        <Link href={`/documents/${item.id}`} className="font-medium hover:text-accent">
          {item.originalFilename}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-muted">
          <span className="mono">{formatSize(item.sizeBytes)}</span>
          {item.versionNumber > 1 && <span className="mono">version {item.versionNumber}</span>}
          {item.duplicateOfId && <span className="text-warn">duplicate</span>}
          {!item.isActive && <span>inactive</span>}
        </div>
      </td>
      <td className="text-ink-2">{SOURCE_TYPE_LABELS[item.sourceType]}</td>
      <td>
        {item.documentType ? (
          <>
            <div>{DOCUMENT_TYPE_LABELS[item.documentType]}</div>
            {item.typeConfidence !== null && (
              <div className="mono text-2xs text-muted">{item.typeConfidence.toFixed(2)}</div>
            )}
          </>
        ) : (
          <span className="text-rule-2">—</span>
        )}
      </td>
      <td>
        <StatusCell item={item} />
      </td>
      <td>
        {item.minCriticalConfidence === null ? (
          <span className="text-rule-2">—</span>
        ) : (
          <ConfidenceBar value={item.minCriticalConfidence} />
        )}
      </td>
      <td>
        {item.blockingIssues === 0 && item.warningIssues === 0 ? (
          <span className="text-rule-2">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {item.blockingIssues > 0 && (
              <span className="chip chip--danger">{item.blockingIssues} blocking</span>
            )}
            {item.warningIssues > 0 && (
              <span className="chip chip--warn">{item.warningIssues} warnings</span>
            )}
          </div>
        )}
      </td>
      <td className="mono whitespace-nowrap text-2xs text-muted">
        {formatDate(item.receivedAt, timeZone)}
      </td>
      <td className="text-right">
        {item.status === 'failed' && (
          <button type="button" onClick={() => onRetry(item.id)} className="btn btn--ghost btn--sm">
            Retry
          </button>
        )}
      </td>
    </tr>
  )
}

function StatusCell({ item }: { item: DocumentListItem }) {
  return (
    <div className="space-y-1">
      <span className={`chip ${STATUS_TONE[item.status]}`}>
        {DOCUMENT_STATUS_LABELS[item.status]}
      </span>
      {item.statusReason && (
        <div
          title={item.statusReason}
          className="line-clamp-2 max-w-[15rem] text-2xs leading-snug text-muted"
        >
          {item.statusReason}
        </div>
      )}
      {isInFlight(item.status) && <StepProgress current={item.currentStep} />}
    </div>
  )
}

/** Processing-stage progress, spec 5.1. */
function StepProgress({ current }: { current: DocumentListItem['currentStep'] }) {
  const index = current ? PIPELINE_UI_STEPS.indexOf(current) : -1
  return (
    <div className="flex gap-0.5" title={current ? WORKFLOW_STEP_LABELS[current] : undefined}>
      {PIPELINE_UI_STEPS.map((step, position) => (
        <span
          key={step}
          className={`h-0.5 w-5 rounded-full ${position <= index ? 'bg-accent' : 'bg-rule'}`}
        />
      ))}
    </div>
  )
}

/**
 * Confidence: read the number and compare the bar. The 0.8 threshold is
 * marked because “0.63” alone does not show whether the score is good.
 */
function ConfidenceBar({ value }: { value: number }) {
  const tone = value < 0.6 ? 'bg-danger' : value < 0.8 ? 'bg-warn' : 'bg-ok'
  return (
    <div className="w-20">
      <div className="mono text-xs">{value.toFixed(2)}</div>
      <div className="relative mt-1 h-1 rounded-full bg-paper-3">
        <div
          className={`h-1 rounded-full ${tone}`}
          style={{ width: `${Math.round(value * 100)}%` }}
        />
        <span aria-hidden className="absolute inset-y-[-2px] left-[80%] w-px bg-rule-2" />
      </div>
    </div>
  )
}

function FilterBar({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  const dirty =
    filters.status !== '' ||
    filters.type !== '' ||
    filters.source !== '' ||
    filters.receivedFrom !== '' ||
    filters.receivedTo !== '' ||
    filters.hasBlocking

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select
        label="Status"
        value={filters.status}
        onChange={(value) => onChange({ ...filters, status: value as Filters['status'] })}
        options={DOCUMENT_STATUSES.map((s) => [s, DOCUMENT_STATUS_LABELS[s]])}
      />
      <Select
        label="Type"
        value={filters.type}
        onChange={(value) => onChange({ ...filters, type: value as Filters['type'] })}
        options={DOCUMENT_TYPES.map((t) => [t, DOCUMENT_TYPE_LABELS[t]])}
      />
      <Select
        label="Source"
        value={filters.source}
        onChange={(value) => onChange({ ...filters, source: value as Filters['source'] })}
        options={SOURCE_TYPES.map((s) => [s, SOURCE_TYPE_LABELS[s]])}
      />

      <label className="block">
        <span className="label mb-1">Received from</span>
        <input
          type="date"
          className="field w-36"
          value={filters.receivedFrom}
          onChange={(event) => onChange({ ...filters, receivedFrom: event.target.value })}
        />
      </label>
      <label className="block">
        <span className="label mb-1">to</span>
        <input
          type="date"
          className="field w-36"
          value={filters.receivedTo}
          onChange={(event) => onChange({ ...filters, receivedTo: event.target.value })}
        />
      </label>

      <label className="flex h-9 shrink-0 cursor-pointer items-center gap-2 text-xs text-ink-2">
        <input
          type="checkbox"
          className="accent-accent"
          checked={filters.hasBlocking}
          onChange={(event) => onChange({ ...filters, hasBlocking: event.target.checked })}
        />
        blocking issues only
      </label>

      {dirty && (
        <div className="flex h-9 items-center">
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="btn btn--ghost btn--sm"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  )
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: [string, string][]
}) {
  return (
    <label className="block">
      <span className="label mb-1">{label}</span>
      <select className="field w-44" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">all</option>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  )
}

function Pagination({ data, onPage }: { data: DocumentListPage; onPage: (page: number) => void }) {
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

function formatSize(bytes: number | null): string {
  if (bytes === null) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string, timeZone: string): string {
  const date = new Date(iso)
  return `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone })} ${date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone })}`
}
