'use client'

import type { BoundingBox } from '@docflow/shared'
import { useEffect, useRef, useState } from 'react'

export interface SourceHighlight {
  fieldName: string
  page: number
  bbox: BoundingBox
}

interface DocumentViewerProps {
  documentId: string
  pageCount: number
  highlights: SourceHighlight[]
  /** Поле, область которого подсвечена и к которой проскроллено. */
  activeField: string | null
  onSelectField: (fieldName: string | null) => void
}

const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2, 3]
const RENDER_WIDTH = 1400

export function DocumentViewer({
  documentId,
  pageCount,
  highlights,
  activeField,
  onSelectField,
}: DocumentViewerProps) {
  const [page, setPage] = useState(1)
  const [zoomIndex, setZoomIndex] = useState(1)
  const [rotation, setRotation] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)

  const active = highlights.find((highlight) => highlight.fieldName === activeField)

  // Клик по полю справа переводит просмотрщик на нужную страницу и подводит
  // область в видимую зону (ТЗ 5.2).
  useEffect(() => {
    if (!active) return
    setPage(active.page)
    const timer = setTimeout(() => {
      stageRef.current
        ?.querySelector('[data-active="true"]')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
    return () => clearTimeout(timer)
  }, [active])

  const zoom = ZOOM_STEPS[zoomIndex] ?? 1
  const onPage = highlights.filter((highlight) => highlight.page === page)

  return (
    <div className="flex h-full gap-3">
      {pageCount > 1 && (
        <div className="flex w-24 shrink-0 flex-col gap-2 overflow-y-auto">
          {Array.from({ length: pageCount }, (_, index) => index + 1).map((number) => (
            <button
              key={number}
              type="button"
              onClick={() => setPage(number)}
              className={`rounded border p-1 ${
                number === page
                  ? 'border-neutral-900'
                  : 'border-[var(--color-border-subtle)] hover:border-neutral-400'
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/documents/${documentId}/pages/${number}/image?width=160`}
                alt={`Страница ${number}`}
                className="w-full"
              />
              <span className="mt-1 block text-center text-xs text-neutral-500">{number}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-2 flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
            disabled={zoomIndex === 0}
            className="rounded border border-[var(--color-border-subtle)] px-2 py-1 disabled:opacity-40"
          >
            −
          </button>
          <span className="w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1))}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            className="rounded border border-[var(--color-border-subtle)] px-2 py-1 disabled:opacity-40"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setRotation((value) => (value + 90) % 360)}
            className="rounded border border-[var(--color-border-subtle)] px-2 py-1"
          >
            Повернуть
          </button>
          <span className="ml-auto text-neutral-500">
            Страница {page} из {pageCount || 1}
          </span>
        </div>

        <div
          ref={stageRef}
          className="flex-1 overflow-auto rounded-lg border border-[var(--color-border-subtle)] bg-neutral-100 p-4"
        >
          <div
            className="relative mx-auto origin-top"
            style={{ width: `${zoom * 100}%`, transform: `rotate(${rotation}deg)` }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/documents/${documentId}/pages/${page}/image?width=${RENDER_WIDTH}`}
              alt={`Страница ${page}`}
              className="block w-full shadow-sm"
            />

            {/* Координаты нормализованы к 0..1, поэтому оверлеи ложатся
                процентами и не зависят от масштаба и разрешения рендера. */}
            {onPage.map((highlight) => {
              const isActive = highlight.fieldName === activeField
              return (
                <button
                  key={highlight.fieldName}
                  type="button"
                  data-active={isActive}
                  onClick={() => onSelectField(isActive ? null : highlight.fieldName)}
                  title={highlight.fieldName}
                  className={`absolute border-2 transition-colors ${
                    isActive
                      ? 'border-amber-500 bg-amber-300/40'
                      : 'border-blue-400/60 bg-blue-300/15 hover:bg-blue-300/35'
                  }`}
                  style={{
                    left: `${highlight.bbox.x * 100}%`,
                    top: `${highlight.bbox.y * 100}%`,
                    width: `${highlight.bbox.width * 100}%`,
                    height: `${highlight.bbox.height * 100}%`,
                  }}
                />
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
