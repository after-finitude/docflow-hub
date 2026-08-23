'use client'

import type { FieldDto, IssueDto } from '@docflow/shared'
import { useEffect, useState } from 'react'

interface FieldCardProps {
  field: FieldDto
  issues: IssueDto[]
  threshold: number
  disabled: boolean
  isActive: boolean
  onFocusSource: () => void
  onSave: (value: string | null) => Promise<void>
}

export function FieldCard({
  field,
  issues,
  threshold,
  disabled,
  isActive,
  onFocusSource,
  onSave,
}: FieldCardProps) {
  const initial = displayValue(field)
  const [value, setValue] = useState(initial)
  const [showRaw, setShowRaw] = useState(false)
  const [saving, setSaving] = useState(false)

  // The value comes from the server after each revalidation; local state
  // picks it up while the field is not being edited.
  useEffect(() => setValue(displayValue(field)), [field])

  const blocking = issues.filter((issue) => issue.severity === 'blocking')
  const dirty = value !== initial

  async function save() {
    setSaving(true)
    await onSave(value.trim() === '' ? null : value)
    setSaving(false)
  }

  return (
    <div
      onMouseEnter={field.sourceFound ? onFocusSource : undefined}
      className={`rounded-[10px] border bg-paper p-3 transition-colors duration-[120ms] ${
        isActive
          ? 'border-accent bg-accent-wash'
          : blocking.length
            ? 'border-danger'
            : 'border-rule'
      }`}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <label className="text-sm font-medium" htmlFor={`field-${field.name}`}>
          {field.label}
          {field.isRequired && (
            <span className="ml-1 text-danger" title="Required field">
              *
            </span>
          )}
          {field.isCritical && (
            <span className="mono ml-2 text-2xs tracking-[0.06em] text-muted uppercase">
              critical
            </span>
          )}
        </label>
        <ConfidenceIndicator confidence={field.confidence} threshold={threshold} />
      </div>

      <div className="flex gap-2">
        <input
          id={`field-${field.name}`}
          value={value}
          disabled={disabled || saving}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => dirty && void save()}
          placeholder="no value"
          className="field"
        />
        {field.rawValue !== null && field.rawValue !== displayValue(field) && (
          <button
            type="button"
            onClick={() => setShowRaw((current) => !current)}
            title="Show the value as written in the document"
            className="btn btn--ghost btn--sm"
          >
            raw
          </button>
        )}
      </div>

      {showRaw && (
        <p className="mt-1 text-2xs text-muted">
          As written: <span className="mono">{field.rawValue}</span>
        </p>
      )}

      {field.isEdited && <p className="mt-1 text-2xs text-muted">Corrected by operator</p>}

      {field.confidenceReason && !field.isEdited && (
        <p className="mt-1 text-2xs text-muted">{field.confidenceReason}</p>
      )}

      <div className="mt-2">
        {field.sourceFound ? (
          <button type="button" onClick={onFocusSource} className="link text-xs">
            Show in document{field.sourcePage ? ` (page ${field.sourcePage})` : ''}
          </button>
        ) : (
          // No source link is available, so show an indicator as required by spec 5.2.
          <span className="chip chip--warn">Source not found</span>
        )}
      </div>

      {issues.map((issue) => (
        <p
          key={issue.id}
          className={`mt-2 text-xs leading-snug ${issue.severity === 'blocking' ? 'text-danger' : 'text-warn'}`}
        >
          {issue.message}
          {issue.expected !== null && issue.actual !== null && (
            <span className="mono block text-2xs text-muted">
              expected: {issue.expected} · actual: {issue.actual}
            </span>
          )}
        </p>
      ))}
    </div>
  )
}

function ConfidenceIndicator({
  confidence,
  threshold,
}: {
  confidence: number | null
  threshold: number
}) {
  if (confidence === null) {
    return <span className="text-2xs text-rule-2">no value</span>
  }

  // Red below the threshold, yellow near it, and green above it (spec 5.2).
  const color =
    confidence < threshold
      ? 'bg-danger'
      : confidence < Math.min(1, threshold + 0.1)
        ? 'bg-warn'
        : 'bg-ok'

  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="mono text-xs">{confidence.toFixed(2)}</span>
      <span className="relative block h-1 w-16 rounded-full bg-paper-3">
        <span
          className={`block h-1 rounded-full ${color}`}
          style={{ width: `${Math.round(confidence * 100)}%` }}
        />
        {/* Threshold marker: the number alone does not show whether the score is good. */}
        <span
          aria-hidden
          className="absolute inset-y-[-2px] w-px bg-rule-2"
          style={{ left: `${Math.round(threshold * 100)}%` }}
        />
      </span>
    </span>
  )
}

/** The input displays the normalized value (spec 5.2). */
function displayValue(field: FieldDto): string {
  if (field.normalizedValue === null || field.normalizedValue === undefined) return ''
  if (typeof field.normalizedValue === 'object') return JSON.stringify(field.normalizedValue)
  return String(field.normalizedValue)
}
