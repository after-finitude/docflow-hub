'use client'

import {
  CLASSIFIABLE_DOCUMENT_TYPES,
  canPerform,
  isInFlight,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  FIELD_FILTERS,
  fieldConfidenceThreshold,
  FIELD_FILTER_LABELS,
  WORKFLOW_STEP_LABELS,
} from '@docflow/shared/browser'
import type {
  ClassifiableDocumentType,
  DocumentDetail,
  ExportDestination,
  ExportDto,
  FieldDto,
  FieldFilter,
  LineItem,
  TableValue,
  RejectReason,
} from '@docflow/shared'
import { apiCall } from '@/lib/client'
import { useStreamEvents } from '@/lib/events'
import { uploadFile } from '../../../lib/upload-file'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { DocumentViewer, type SourceHighlight } from './document-viewer'
import { FieldCard } from './field-card'
import { LineItemsEditor } from './line-items-editor'
import { TransactionsEditor } from './transactions-editor'
import { ExportPanel } from './export-panel'
import { RejectForm } from './reject-form'
import { ReplaceFileButton } from './replace-file-button'

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
      void apiCall(`/documents/${document.id}/review-opened`, { method: 'POST' })
    }
  }, [document.id, document.status])

  // While processing, follow the document: reload on its stream events, or poll
  // every two seconds while the stream is down (spec 5.1). A failed reload is
  // retried either way. Once processing ends, reloads stop so edits are kept.
  const [changes, setChanges] = useState(0)
  const live = useStreamEvents((event) => {
    if (processing && event.type === 'document' && event.documentId === document.id)
      setChanges((count) => count + 1)
  })

  useEffect(() => {
    if (!processing) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      const result = await apiCall<DocumentDetail>(`/documents/${document.id}`, {
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      })
      if (controller.signal.aborted) return
      if (result.ok) setDocument(result.data)
      setRefreshFailed(!result.ok)
      if (!live || !result.ok) timer = setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [document.id, processing, live, changes])

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
    const result = await apiCall<DocumentDetail>(path, init)
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return false
    }
    // Every response contains the latest document, updated issues,
    // and current Approve availability (spec 5.2).
    setDocument(result.data)
    return true
  }

  const saveField = (name: string) => async (value: string | null) => {
    await call(`/documents/${document.id}/fields/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ value }),
    })
  }

  async function saveTable(items: TableValue) {
    if (!lineItemsField) return false
    const saved = await call(`/documents/${document.id}/fields/${lineItemsField.name}`, {
      method: 'PATCH',
      body: JSON.stringify({ value: items }),
    })
    if (saved) setTableDirty(false)
    return saved
  }

  async function changeType(type: ClassifiableDocumentType) {
    await call(`/documents/${document.id}/type`, {
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
      const exported = await apiCall<ExportDto>(`/documents/${document.id}/export`, {
        method: 'POST',
        body: JSON.stringify({ destination, exportKey }),
      })
      if (!exported.ok) {
        setError(exported.message)
        return
      }
      const result = exported.data
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
      const refreshed = await apiCall<DocumentDetail>(`/documents/${document.id}`)
      if (refreshed.ok) setDocument(refreshed.data)
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
      await call(`/documents/${document.id}/reject`, {
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

        {/* relative: absolutely positioned descendants (sr-only labels in long
            tables) must scroll inside this column, not stretch the page. */}
        <section className="relative flex min-w-0 basis-[45%] flex-col overflow-y-auto pr-1">
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
                onClick={() => void call(`/documents/${document.id}/approve`, { method: 'POST' })}
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
                onClick={() => void call(`/documents/${document.id}/reprocess`, { method: 'POST' })}
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

function parseLineItems(field: FieldDto): LineItem[] {
  if (Array.isArray(field.normalizedValue)) return field.normalizedValue as LineItem[]
  return []
}
