'use client'

import { ACCEPTED_MIME_TYPES, UPLOAD_MAX_BYTES } from '@docflow/shared'
import { useRef, useState, type DragEvent } from 'react'

interface UploaderProps {
  onUploaded: () => void
}

interface Rejected {
  name: string
  reason: string
}

export function Uploader({ onUploaded }: UploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rejected, setRejected] = useState<Rejected[]>([])

  async function send(files: File[]) {
    if (files.length === 0) return
    setBusy(true)
    setRejected([])
    const failures: Rejected[] = []

    for (const file of files) {
      // Размер и тип проверяются и на сервере; здесь — чтобы не гонять
      // заведомо негодный файл по сети и сразу назвать причину.
      if (file.size > UPLOAD_MAX_BYTES) {
        failures.push({ name: file.name, reason: 'больше 25 МБ' })
        continue
      }
      if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
        failures.push({ name: file.name, reason: 'допустимы только PDF, JPEG и PNG' })
        continue
      }

      const body = new FormData()
      body.append('file', file)
      try {
        const response = await fetch('/api/documents', { method: 'POST', body })
        if (!response.ok) {
          const detail = (await response.json().catch(() => null)) as { message?: string } | null
          failures.push({ name: file.name, reason: detail?.message ?? `ошибка ${response.status}` })
        }
      } catch {
        failures.push({ name: file.name, reason: 'сервис недоступен' })
      }
    }

    setRejected(failures)
    setBusy(false)
    onUploaded()
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    void send(Array.from(event.dataTransfer.files))
  }

  return (
    <div>
      {/* Приём файлов — не главный герой экрана, а узкая полоса над очередью:
          оператор большую часть времени разбирает уже принятое. */}
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        role="button"
        tabIndex={0}
        aria-busy={busy}
        className={`flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-dashed px-4 py-3 transition-colors duration-[120ms] ${
          dragging ? 'border-accent bg-accent-wash' : 'border-rule-2 bg-paper hover:bg-paper-2'
        }`}
      >
        <span className="text-sm font-medium">
          {busy ? 'Загружаем…' : 'Перетащите файлы или нажмите, чтобы выбрать'}
        </span>
        <span className="mono text-2xs whitespace-nowrap text-muted sm:ml-auto">
          PDF · JPEG · PNG · до 25 МБ
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_MIME_TYPES.join(',')}
          className="hidden"
          onChange={(event) => {
            void send(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      </div>

      {rejected.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rejected.map((item) => (
            <li key={item.name} className="text-xs text-danger">
              <span className="mono">{item.name}</span> — {item.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
