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

/** Таблица позиций с добавлением и удалением строк (ТЗ 5.2). */
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

  const cell =
    'w-full rounded border border-[var(--color-border-subtle)] px-2 py-1 text-sm disabled:bg-neutral-50'

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
      <h3 className="mb-3 text-sm font-medium">Позиции</h3>

      {items.length === 0 ? (
        <p className="text-xs text-neutral-500">Позиции отсутствуют</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th className="pb-1 font-medium">Описание</th>
              <th className="w-20 pb-1 font-medium">Кол-во</th>
              <th className="w-24 pb-1 font-medium">Цена</th>
              <th className="w-24 pb-1 font-medium">Сумма</th>
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
                    className="text-neutral-400 hover:text-red-600 disabled:opacity-40"
                    title="Удалить строку"
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
          className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-40"
        >
          Добавить строку
        </button>
        {dirty && (
          <button
            type="button"
            disabled={disabled || saving}
            onClick={() => void save()}
            className="rounded-md bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-40"
          >
            {saving ? 'Сохранение…' : 'Сохранить позиции'}
          </button>
        )}
      </div>
    </div>
  )
}
