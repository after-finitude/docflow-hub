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

  // Значение приходит с сервера после каждой перевалидации — местное
  // состояние подхватывает его, пока поле не редактируется.
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
      className={`rounded-lg border bg-[var(--color-surface)] p-4 transition-colors ${
        isActive
          ? 'border-amber-500'
          : blocking.length
            ? 'border-red-300'
            : 'border-[var(--color-border-subtle)]'
      }`}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <label className="text-sm font-medium" htmlFor={`field-${field.name}`}>
          {field.label}
          {field.isRequired && <span className="ml-1 text-red-500">*</span>}
          {field.isCritical && (
            <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
              критичное
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
          placeholder="значение отсутствует"
          className="w-full rounded-md border border-[var(--color-border-subtle)] px-3 py-2 text-sm outline-none focus:border-neutral-500 disabled:bg-neutral-50"
        />
        {field.rawValue !== null && field.rawValue !== displayValue(field) && (
          <button
            type="button"
            onClick={() => setShowRaw((current) => !current)}
            title="Показать значение как в документе"
            className="rounded-md border border-[var(--color-border-subtle)] px-2 text-xs text-neutral-500 hover:bg-neutral-100"
          >
            raw
          </button>
        )}
      </div>

      {showRaw && (
        <p className="mt-1 text-xs text-neutral-500">Как в документе: {field.rawValue}</p>
      )}

      {field.isEdited && <p className="mt-1 text-xs text-neutral-500">Исправлено оператором</p>}

      {field.confidenceReason && !field.isEdited && (
        <p className="mt-1 text-xs text-neutral-500">{field.confidenceReason}</p>
      )}

      <div className="mt-2">
        {field.sourceFound ? (
          <button
            type="button"
            onClick={onFocusSource}
            className="text-xs text-blue-700 underline hover:text-blue-900"
          >
            Показать в документе{field.sourcePage ? ` (стр. ${field.sourcePage})` : ''}
          </button>
        ) : (
          // Ссылки нет и выводится признак — требование ТЗ 5.2.
          <span className="text-xs text-amber-700">Источник не найден</span>
        )}
      </div>

      {issues.map((issue) => (
        <p
          key={issue.id}
          className={`mt-2 text-xs ${issue.severity === 'blocking' ? 'text-red-600' : 'text-amber-700'}`}
        >
          {issue.message}
          {issue.expected !== null && issue.actual !== null && (
            <span className="block text-neutral-500">
              ожидалось: {issue.expected} · фактически: {issue.actual}
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
    return <span className="text-xs text-neutral-400">нет значения</span>
  }

  // Красный ниже порога, жёлтый пограничный, зелёный выше (ТЗ 5.2).
  const color =
    confidence < threshold
      ? 'bg-red-500'
      : confidence < Math.min(1, threshold + 0.1)
        ? 'bg-amber-500'
        : 'bg-green-500'

  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="text-xs tabular-nums text-neutral-600">{confidence.toFixed(2)}</span>
      <span className="block h-1.5 w-16 rounded bg-neutral-200">
        <span
          className={`block h-1.5 rounded ${color}`}
          style={{ width: `${Math.round(confidence * 100)}%` }}
        />
      </span>
    </span>
  )
}

/** В поле ввода показывается нормализованное значение (ТЗ 5.2). */
function displayValue(field: FieldDto): string {
  if (field.normalizedValue === null || field.normalizedValue === undefined) return ''
  if (typeof field.normalizedValue === 'object') return JSON.stringify(field.normalizedValue)
  return String(field.normalizedValue)
}
