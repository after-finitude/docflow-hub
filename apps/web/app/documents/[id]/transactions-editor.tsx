'use client'

import type { BankTransaction, FieldDto, IssueDto } from '@docflow/shared'
import { useState, type FormEvent } from 'react'

const COLUMNS = [
  { name: 'date', label: 'Date', numeric: false },
  { name: 'description', label: 'Description', numeric: false },
  { name: 'reference', label: 'Reference', numeric: false },
  { name: 'payment_type', label: 'Payment type', numeric: false },
  { name: 'credit', label: 'Paid in', numeric: true },
  { name: 'debit', label: 'Paid out', numeric: true },
  { name: 'balance', label: 'Balance', numeric: true },
] as const

const EMPTY_ROW = {
  date: '',
  description: '',
  reference: '',
  payment_type: '',
  credit: '',
  debit: '',
  balance: '',
}
type DraftRow = typeof EMPTY_ROW

const number = (text: string) => (text.trim() === '' ? null : Number(text))

export function TransactionsEditor({
  field,
  issues,
  disabled,
  dirty,
  onDirtyChange,
  onSave,
  onFocusSource,
}: {
  field: FieldDto
  issues: IssueDto[]
  disabled: boolean
  dirty: boolean
  onDirtyChange: (dirty: boolean) => void
  onSave: (rows: BankTransaction[]) => Promise<boolean>
  onFocusSource: () => void
}) {
  const [rows, setRows] = useState<DraftRow[]>(() => {
    const value = Array.isArray(field.normalizedValue)
      ? (field.normalizedValue as BankTransaction[])
      : []
    return value.map((row) => ({
      date: row.date ?? '',
      description: row.description,
      reference: row.reference ?? '',
      payment_type: row.payment_type ?? '',
      credit: String(row.credit ?? ''),
      debit: String(row.debit ?? ''),
      balance: String(row.balance ?? ''),
    }))
  })
  const [saving, setSaving] = useState(false)
  const locked = disabled || saving

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    try {
      await onSave(
        rows.map((row) => ({
          date: row.date.trim() || null,
          description: row.description,
          reference: row.reference.trim() || null,
          payment_type: row.payment_type.trim() || null,
          credit: number(row.credit),
          debit: number(row.debit),
          balance: number(row.balance),
        })),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} className="panel min-w-0 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">
          Transactions <span className="mono text-muted">({rows.length})</span>
        </h3>
        {field.sourceFound ? (
          <button type="button" onClick={onFocusSource} className="link text-xs">
            Show table source{field.sourcePage ? ` (page ${field.sourcePage})` : ''}
          </button>
        ) : (
          <span className="chip chip--warn">Source not found</span>
        )}
      </div>
      <p className="mb-3 text-xs text-muted">
        Paid in increases the account balance; paid out decreases it. Keep dates as printed.
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">
          {field.normalizedValue === null
            ? 'No transactions extracted. Add the rows from the statement.'
            : 'No account activity recorded.'}
        </p>
      ) : (
        <div
          className="overflow-x-auto"
          role="region"
          aria-label="Statement transactions"
          tabIndex={0}
        >
          <table className="w-full min-w-[920px] text-sm">
            <caption className="sr-only">Statement transactions in printed order</caption>
            <thead>
              <tr className="text-left text-xs text-muted">
                {COLUMNS.map((column) => (
                  <th key={column.name} scope="col" className="pb-2 pr-2 font-medium">
                    {column.label}
                  </th>
                ))}
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {COLUMNS.map((column) => (
                    <td
                      key={column.name}
                      className={`py-1 pr-2 ${column.name === 'description' ? 'min-w-56' : 'min-w-28'}`}
                    >
                      <input
                        className="field h-8 px-2 text-xs"
                        aria-label={`${column.label}, transaction ${index + 1}`}
                        disabled={locked}
                        type={column.numeric ? 'number' : 'text'}
                        step={column.numeric ? 'any' : undefined}
                        min={column.name === 'credit' || column.name === 'debit' ? 0 : undefined}
                        value={row[column.name]}
                        onChange={(event) => {
                          setRows((current) =>
                            current.map((item, i) =>
                              i === index ? { ...item, [column.name]: event.target.value } : item,
                            ),
                          )
                          onDirtyChange(true)
                        }}
                      />
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      disabled={locked}
                      aria-label={`Remove transaction ${index + 1}`}
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        setRows((current) => current.filter((_, i) => i !== index))
                        onDirtyChange(true)
                      }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={locked}
          className="btn btn--ghost btn--sm"
          onClick={() => {
            setRows((current) => [...current, { ...EMPTY_ROW }])
            onDirtyChange(true)
          }}
        >
          Add transaction
        </button>
        {rows.length === 0 && field.normalizedValue === null && (
          <button
            type="button"
            disabled={locked}
            className="btn btn--ghost btn--sm"
            onClick={() => onDirtyChange(true)}
          >
            Confirm no activity
          </button>
        )}
        {dirty && (
          <button type="submit" disabled={locked} className="btn btn--primary btn--sm">
            {saving ? 'Saving…' : 'Save transactions'}
          </button>
        )}
      </div>
      {field.isEdited && <p className="mt-2 text-xs text-muted">Corrected by operator</p>}
      {field.confidenceReason && (
        <p className="mt-2 text-xs text-muted">{field.confidenceReason}</p>
      )}
      {issues.map((issue) => (
        <p
          key={issue.id}
          className={`mt-2 text-xs ${issue.severity === 'blocking' ? 'text-danger' : 'text-warn'}`}
        >
          {issue.message}
          {issue.expected !== null && issue.actual !== null && (
            <span className="mono block text-muted">
              expected: {issue.expected} · actual: {issue.actual}
            </span>
          )}
        </p>
      ))}
    </form>
  )
}
