'use client'

import {
  ACCEPTED_MIME_TYPES,
  CLASSIFIABLE_DOCUMENT_TYPES,
  canPerform,
  isInFlight,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  EXPORT_DESTINATIONS,
  GOOGLE_WORKSPACE_ENABLED,
  EXPORT_DESTINATION_LABELS,
  FIELD_FILTERS,
  fieldConfidenceThreshold,
  FIELD_FILTER_LABELS,
  WORKFLOW_STEP_LABELS,
  REJECT_REASONS,
  REJECT_REASON_LABELS,
  type ClassifiableDocumentType,
  type DocumentDetail,
  type ExportDestination,
  type ExportDto,
  type FieldDto,
  type FieldFilter,
  type LineItem,
  type TableValue,
  type RejectReason,
} from '@docflow/shared'
import { uploadFile } from '../../../lib/upload-file'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DocumentViewer, type SourceHighlight } from './document-viewer'
import { FieldCard } from './field-card'
import { LineItemsEditor } from './line-items-editor'
import { TransactionsEditor } from './transactions-editor'

export function ReviewWorkspace({ initial }: { initial: DocumentDetail }) {
  const router = useRouter()
  const [document, setDocument] = useState(initial)
  const [filter, setFilter] = useState<FieldFilter>('all')
  const [activeField, setActiveField] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [tableDirty, setTableDirty] = useState(false)
  const actionsDisabled = busy || tableDirty
  const processing = isInFlight(document.status)

  useEffect(() => {
    performance.clearMarks('docflow-review-ready')
  }, [document.id])

  useEffect(() => {
    if (document.status === 'needs_review') {
      void fetch(`/api/documents/${document.id}/review-opened`, { method: 'POST' }).catch(() => {})
    }
  }, [document.id, document.status])

  useEffect(() => {
    if (!processing) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const response = await fetch(`/api/documents/${document.id}`, {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        })
        if (!response.ok) throw new Error('Refresh failed')
        const updated = (await response.json()) as DocumentDetail
        if (!controller.signal.aborted) {
          setDocument(updated)
          setRefreshFailed(false)
        }
      } catch {
        if (!controller.signal.aborted) setRefreshFailed(true)
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 2000)
      }
    }
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [document.id, processing])

  const exportReserved = document.exports.some(
    (item) => item.status === 'pending' || item.status === 'failed',
  )
  const readOnly = exportReserved || !canPerform('editField', document.status)

  const issuesByField = useMemo(() => {
    const map = new Map<string, DocumentDetail['issues']>()
    for (const issue of document.issues) {
      if (!issue.fieldName || issue.resolvedAt) continue
      map.set(issue.fieldName, [...(map.get(issue.fieldName) ?? []), issue])
    }
    return map
  }, [document.issues])

  const documentIssues = document.issues.filter((issue) => !issue.fieldName && !issue.resolvedAt)

  /** Order: blocking → below threshold → everything else (spec 5.2). */
  const orderedFields = useMemo(() => {
    const weight = (field: FieldDto) => {
      if (issuesByField.get(field.name)?.some((issue) => issue.severity === 'blocking')) return 0
      if (
        field.confidence === null ||
        field.confidence < fieldConfidenceThreshold(field.isCritical, document.thresholds)
      )
        return 1
      return 2
    }
    return document.fields
      .filter((field) => field.valueType !== 'array')
      .toSorted((a, b) => weight(a) - weight(b))
  }, [document.fields, issuesByField, document.thresholds])

  const visibleFields = orderedFields.filter((field) => {
    switch (filter) {
      case 'missing':
        return field.rawValue === null
      case 'low_confidence':
        return (
          field.confidence === null ||
          field.confidence < fieldConfidenceThreshold(field.isCritical, document.thresholds)
        )
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
    // Document actions must not discard the draft; field PATCH requests can still save it.
    if (tableDirty && init.method === 'POST') {
      setError('Save table changes before continuing')
      return false
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
      })
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { message?: string } | null
        setError(detail?.message ?? `Error ${response.status}`)
        return false
      }
      // Every response contains the latest document, updated issues,
      // and current Approve availability (spec 5.2).
      setDocument((await response.json()) as DocumentDetail)
      return true
    } catch {
      setError('Service unavailable')
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

  async function saveTable(items: TableValue) {
    if (!lineItemsField) return false
    const saved = await call(`/api/documents/${document.id}/fields/${lineItemsField.name}`, {
      method: 'PATCH',
      body: JSON.stringify({ value: items }),
    })
    if (saved) setTableDirty(false)
    return saved
  }

  async function changeType(type: ClassifiableDocumentType) {
    await call(`/api/documents/${document.id}/type`, {
      method: 'POST',
      body: JSON.stringify({ type }),
    })
  }

  /**
   * The export response is the export record, not the document, so reload the
   * document separately: its status may have changed to exported.
   */
  async function runExport(destination: ExportDestination, exportKey?: string) {
    if (tableDirty) {
      setError('Save table changes before exporting')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/documents/${document.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination, exportKey }),
      })
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { message?: string } | null
        setError(detail?.message ?? `Error ${response.status}`)
        return
      }
      const result = (await response.json()) as ExportDto
      if (result.status === 'failed') {
        setError(`Export failed (${result.errorCode}). You can retry it`)
      }
      setDocument((current) => ({
        ...current,
        status: result.status === 'succeeded' ? 'exported' : current.status,
        exports: [...current.exports.filter((item) => item.id !== result.id), result],
      }))
      if (result.status === 'succeeded' && destination === 'file_json') {
        await downloadJson(result.id)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Service unavailable')
    } finally {
      // A lost response may still have left a saved Pending export to retry.
      const refreshed = await fetch(`/api/documents/${document.id}`)
        .then((response) => (response.ok ? (response.json() as Promise<DocumentDetail>) : null))
        .catch(() => null)
      if (refreshed) setDocument(refreshed)
      setBusy(false)
    }
  }

  async function downloadJson(exportId: string) {
    const response = await fetch(`/api/documents/${document.id}/exports/${exportId}/file`)
    if (!response.ok) {
      throw new Error('JSON could not be downloaded. Use Download JSON to retry')
    }
    const url = URL.createObjectURL(await response.blob())
    const link = window.document.createElement('a')
    link.href = url
    link.download = `docflow-${document.id}.json`
    window.document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function runDownload(exportId: string) {
    setBusy(true)
    setError(null)
    try {
      await downloadJson(exportId)
    } catch {
      setError('JSON could not be downloaded. Use Download JSON to retry')
    } finally {
      setBusy(false)
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
      <header className="mb-4 flex items-center justify-between gap-4 border-b border-rule pb-3">
        <div className="min-w-0">
          <Link href="/inbox" className="link text-xs">
            ← Back to queue
          </Link>
          <h1 className="mt-1 truncate text-lg">{document.originalFilename}</h1>
          {document.versionNumber > 1 && (
            <p className="mono text-2xs text-muted">
              version {document.versionNumber}
              {document.previousVersionId && (
                <>
                  {' · '}
                  <Link href={`/documents/${document.previousVersionId}`} className="link">
                    previous
                  </Link>
                </>
              )}
            </p>
          )}
          {!document.isActive && (
            <p className="text-2xs text-warn">
              This version is inactive: replaced by a newer version or removed at the source
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="chip chip--neutral">{DOCUMENT_STATUS_LABELS[document.status]}</span>
          {document.blockingIssues > 0 && (
            <span className="chip chip--danger">blocking: {document.blockingIssues}</span>
          )}
          {document.warningIssues > 0 && (
            <span className="chip chip--warn">warnings: {document.warningIssues}</span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex min-w-0 basis-[55%] flex-col">
          {document.pageCount ? (
            <DocumentViewer
              onReady={() => {
                if (!performance.getEntriesByName('docflow-review-ready').length)
                  performance.mark('docflow-review-ready')
              }}
              documentId={document.id}
              pageCount={document.pageCount}
              highlights={highlights}
              activeField={activeField}
              onSelectField={setActiveField}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-[10px] border border-dashed border-rule-2 text-sm text-muted">
              {!document.hasOriginal
                ? 'The original was not stored. Upload a file up to 25 MB.'
                : document.status === 'rejected'
                  ? 'The document was rejected before preview generation.'
                  : 'Document is not ready yet'}
            </div>
          )}
        </section>

        <section className="flex min-w-0 basis-[45%] flex-col overflow-y-auto pr-1">
          <div className="panel mb-3 p-4">
            {processing && (
              <p role="status" className="mb-3 text-xs text-ink-2">
                {refreshFailed
                  ? 'Could not refresh processing status. Retrying automatically…'
                  : `${document.currentStep ? WORKFLOW_STEP_LABELS[document.currentStep] : 'Processing'} in progress. Results will appear here automatically.`}
              </p>
            )}
            <label className="block">
              <span className="label mb-1">Document type</span>
              <select
                className="field"
                value={document.documentType ?? 'unknown'}
                disabled={
                  actionsDisabled || exportReserved || !canPerform('changeType', document.status)
                }
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
            <p className="mt-1 text-2xs text-muted">
              Changing the type restarts extraction with the new schema
            </p>

            {exportReserved && (
              <p className="mt-3 text-xs text-ink-2">
                Export data is saved. Retry the export to finish delivery.
              </p>
            )}

            {document.statusReason && (
              <p className="mt-3 text-xs text-ink-2">{document.statusReason}</p>
            )}

            {/* Document-level issues: OCR quality and suspected multiple documents
                in one file. These issues do not belong to individual fields. */}
            {documentIssues.length > 0 && (
              <ul className="mt-3 space-y-1.5 border-l-2 border-warn pl-3">
                {documentIssues.map((issue) => (
                  <li key={issue.id} className="text-xs leading-snug text-ink-2">
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}

            {error && (
              <p role="alert" className="mt-3 text-xs text-danger">
                {error}
              </p>
            )}

            {tableDirty && (
              <p role="status" className="mt-3 text-xs text-ink-2">
                Save table changes before approving, exporting or restarting processing.
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!document.canApprove || actionsDisabled}
                title={
                  document.blockingIssues > 0 ? 'There are unresolved blocking issues' : undefined
                }
                onClick={() =>
                  void call(`/api/documents/${document.id}/approve`, { method: 'POST' })
                }
                className="btn btn--primary"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={
                  actionsDisabled || exportReserved || !canPerform('reject', document.status)
                }
                onClick={() => setRejecting(true)}
                className="btn btn--danger"
              >
                Reject
              </button>
              <button
                type="button"
                disabled={
                  actionsDisabled ||
                  exportReserved ||
                  !document.hasOriginal ||
                  !canPerform('reprocess', document.status)
                }
                onClick={() =>
                  void call(`/api/documents/${document.id}/reprocess`, { method: 'POST' })
                }
                className="btn btn--ghost"
              >
                Reprocess
              </button>
              {/* Original replacement (spec §10). Source documents must be changed
                  at the source, so they do not have this button. */}
              {document.sourceType === 'upload' && document.isActive && (
                <ReplaceFileButton
                  disabled={actionsDisabled || readOnly}
                  onSelect={async (file) => {
                    setBusy(true)
                    setError(null)
                    try {
                      const response = await uploadFile(file, document.id)
                      const detail = (await response.json().catch(() => null)) as {
                        id?: string
                        message?: string
                      } | null
                      if (!response.ok || !detail?.id) {
                        setError(detail?.message ?? `Error ${response.status}`)
                        return
                      }
                      // Replacement creates a new version, which is a different document.
                      router.push(`/documents/${detail.id}`)
                    } catch {
                      setError('Service unavailable')
                    } finally {
                      setBusy(false)
                    }
                  }}
                />
              )}
            </div>

            {rejecting && <RejectForm onCancel={() => setRejecting(false)} onSubmit={reject} />}

            {canPerform('export', document.status) && (
              <ExportPanel
                exports={document.exports}
                busy={actionsDisabled}
                onExport={(destination, exportKey) => void runExport(destination, exportKey)}
                onDownload={(exportId) => void runDownload(exportId)}
              />
            )}
          </div>

          <div
            role="tablist"
            aria-label="Field filter"
            className="mb-3 flex w-fit shrink-0 rounded-[6px] border border-rule p-0.5"
          >
            {FIELD_FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={filter === option}
                onClick={() => setFilter(option)}
                className={`rounded-[4px] px-2.5 py-1 text-xs whitespace-nowrap transition-colors duration-[120ms] ${
                  filter === option
                    ? 'bg-accent-wash font-medium text-accent'
                    : 'text-ink-2 hover:bg-paper-2'
                }`}
              >
                {FIELD_FILTER_LABELS[option]}
              </button>
            ))}
          </div>

          <div className="space-y-3">
            {visibleFields.length === 0 && (
              <p className="rounded-[10px] border border-dashed border-rule-2 p-6 text-center text-sm text-muted">
                {document.fields.length === 0
                  ? document.status === 'rejected'
                    ? 'No extracted fields: the document was rejected.'
                    : 'Fields will appear after extraction'
                  : 'No fields match the filter'}
              </p>
            )}
            {visibleFields.map((field) => (
              <FieldCard
                key={field.name}
                field={field}
                issues={issuesByField.get(field.name) ?? []}
                threshold={fieldConfidenceThreshold(field.isCritical, document.thresholds)}
                disabled={busy || readOnly}
                isActive={activeField === field.name}
                onFocusSource={() => setActiveField(field.name)}
                onSave={saveField(field.name)}
              />
            ))}

            {lineItemsField?.name === 'transactions' ? (
              <TransactionsEditor
                key={lineItemsField.rawValue ?? 'empty'}
                field={lineItemsField}
                issues={issuesByField.get(lineItemsField.name) ?? []}
                disabled={busy || readOnly}
                dirty={tableDirty}
                onDirtyChange={setTableDirty}
                onSave={saveTable}
                onFocusSource={() => setActiveField(lineItemsField.name)}
              />
            ) : (
              lineItemsField && (
                <LineItemsEditor
                  key={lineItemsField.rawValue ?? 'empty'}
                  value={parseLineItems(lineItemsField)}
                  disabled={busy || readOnly}
                  dirty={tableDirty}
                  onDirtyChange={setTableDirty}
                  onSave={saveTable}
                />
              )
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

function ExportPanel({
  exports,
  busy,
  onExport,
  onDownload,
}: {
  exports: ExportDto[]
  busy: boolean
  onExport: (destination: ExportDestination, exportKey?: string) => void
  onDownload: (exportId: string) => void
}) {
  return (
    <div className="mt-4 border-t border-rule pt-3">
      <h3 className="mono text-2xs tracking-[0.06em] text-muted uppercase">Export</h3>

      {exports.map((item) => (
        <p key={item.id} className="mt-1.5 text-xs">
          <span className="text-ink-2">{EXPORT_DESTINATION_LABELS[item.destination]}</span>{' '}
          {item.status === 'succeeded' ? (
            <>
              <span className="text-ok">completed {formatWhen(item.exportedAt)}</span>
              {item.destination === 'file_json' && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm ml-2"
                  disabled={busy}
                  onClick={() => onDownload(item.id)}
                >
                  Download JSON
                </button>
              )}
            </>
          ) : item.status === 'failed' ? (
            <span className="text-danger">
              failed (<span className="mono">{item.errorCode}</span>), attempts {item.attempts}
            </span>
          ) : (
            <span className="text-muted">pending</span>
          )}
          {item.status !== 'succeeded' && (
            <button
              type="button"
              className="btn btn--ghost btn--sm ml-2"
              disabled={busy || (item.destination === 'google_sheets' && !GOOGLE_WORKSPACE_ENABLED)}
              title={
                item.destination === 'google_sheets' && !GOOGLE_WORKSPACE_ENABLED
                  ? 'Google Sheets is temporarily disabled'
                  : undefined
              }
              onClick={() => onExport(item.destination, item.exportKey)}
            >
              Retry export
            </button>
          )}
        </p>
      ))}

      <div className="mt-2 flex flex-wrap gap-2">
        {EXPORT_DESTINATIONS.map((destination) => {
          if (exports.some((item) => item.destination === destination)) return null
          return (
            <button
              key={destination}
              type="button"
              disabled={busy || (destination === 'google_sheets' && !GOOGLE_WORKSPACE_ENABLED)}
              onClick={() => onExport(destination)}
              className="btn btn--ghost btn--sm"
            >
              Export to {EXPORT_DESTINATION_LABELS[destination]}
              {destination === 'google_sheets' && !GOOGLE_WORKSPACE_ENABLED
                ? ' (temporarily disabled)'
                : ''}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function formatWhen(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
    : ''
}

/**
 * Original replacement uses a hidden input because the native file picker
 * button does not match the other panel actions.
 */
function ReplaceFileButton({
  disabled,
  onSelect,
}: {
  disabled: boolean
  onSelect: (file: File) => void | Promise<void>
}) {
  const input = useRef<HTMLInputElement>(null)

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_MIME_TYPES.join(',')}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Clear the value so selecting the same file again triggers change.
          event.target.value = ''
          if (file) void onSelect(file)
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        title="Upload a different file: this creates a new document version"
        className="btn btn--ghost"
      >
        Replace file
      </button>
    </>
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
    <div className="mt-3 rounded-[6px] border border-rule bg-paper-2 p-3">
      <label className="block">
        <span className="label mb-1">Rejection reason</span>
        <select
          className="field"
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
        className="field mt-2"
        rows={2}
        placeholder="Comment (optional)"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void onSubmit(reason, comment)}
          className="btn btn--danger btn--sm"
        >
          Reject document
        </button>
        <button type="button" onClick={onCancel} className="btn btn--ghost btn--sm">
          Cancel
        </button>
      </div>
    </div>
  )
}

function parseLineItems(field: FieldDto): LineItem[] {
  if (Array.isArray(field.normalizedValue)) return field.normalizedValue as LineItem[]
  return []
}
