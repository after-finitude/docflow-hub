'use client'

import type { LineItem } from '@docflow/shared'
import { useState } from 'react'

interface LineItemsEditorProps {
  value: LineItem[]
  disabled: boolean
  onSave: (items: LineItem[]) => Promise<void>
}

const EMPTY_ITEM: LineItem = { description: '', quantity: null, unit_price: null, amount: null }

function parseNumber(text: string): number | null {
  if (text.trim() === '') return null
  const parsed = Number(text.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

/** Line-items table with row addition and removal (spec 5.2). */
export function LineItemsEditor({ value, disabled, onSave }: LineItemsEditorProps) {
  const [items, setItems] = useState<LineItem[]>(value)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  function update(index: number, patch: Partial<LineItem>) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)))
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    await onSave(items)
    setSaving(false)
    setDirty(false)
  }

  const cell = 'field field--mono h-8 px-2 text-xs'

  return (
    <div className="panel p-4">
      <h3 className="mb-3 text-sm font-medium">Line items</h3>

      {items.length === 0 ? (
        <p className="text-xs text-muted">No line items</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="mono text-left text-2xs tracking-[0.06em] text-muted uppercase">
              <th className="pb-1 font-medium">Description</th>
              <th className="w-20 pb-1 font-medium">Qty</th>
              <th className="w-24 pb-1 font-medium">Price</th>
              <th className="w-24 pb-1 font-medium">Amount</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={index}>
                <td className="py-1 pr-2">
                  <input
                    className={cell}
                    disabled={disabled}
                    value={item.description}
                    onChange={(event) => update(index, { description: event.target.value })}
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    className={cell}
                    disabled={disabled}
                    value={item.quantity ?? ''}
                    onChange={(event) =>
                      update(index, { quantity: parseNumber(event.target.value) })
                    }
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    className={cell}
                    disabled={disabled}
                    value={item.unit_price ?? ''}
                    onChange={(event) =>
                      update(index, { unit_price: parseNumber(event.target.value) })
                    }
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    className={cell}
                    disabled={disabled}
                    value={item.amount ?? ''}
                    onChange={(event) => update(index, { amount: parseNumber(event.target.value) })}
                  />
                </td>
                <td className="py-1">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setItems((current) => current.filter((_, i) => i !== index))
                      setDirty(true)
                    }}
                    className="text-muted transition-colors duration-[120ms] hover:text-danger disabled:opacity-40"
                    title="Remove row"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setItems((current) => [...current, { ...EMPTY_ITEM }])
            setDirty(true)
          }}
          className="btn btn--ghost btn--sm"
        >
          Add row
        </button>
        {dirty && (
          <button
            type="button"
            disabled={disabled || saving}
            onClick={() => void save()}
            className="btn btn--primary btn--sm"
          >
            {saving ? 'Saving…' : 'Save line items'}
          </button>
        )}
      </div>
    </div>
  )
}
