'use client'

import type { BoundingBox } from '@docflow/shared'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface SourceHighlight {
  fieldName: string
  page: number
  bbox: BoundingBox
}

interface DocumentViewerProps {
  onReady?: () => void
  documentId: string
  pageCount: number
  highlights: SourceHighlight[]
  /** Field whose source area is highlighted and scrolled into view. */
  activeField: string | null
  onSelectField: (fieldName: string | null) => void
}

const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2, 3]
const RENDER_WIDTH = 1400

export function DocumentViewer({
  onReady,
  documentId,
  pageCount,
  highlights,
  activeField,
  onSelectField,
}: DocumentViewerProps) {
  const [page, setPage] = useState(1)
  const [zoomIndex, setZoomIndex] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [loaded, setLoaded] = useState({ page: 0, ratio: 1 })
  const stageRef = useRef<HTMLDivElement>(null)
  const measureImage = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image?.complete || !image.naturalWidth) return
      const ratio = image.naturalWidth / image.naturalHeight
      setLoaded((current) =>
        current.page === page && current.ratio === ratio ? current : { page, ratio },
      )
    },
    [page],
  )

  useEffect(() => {
    if (loaded.page === page) onReady?.()
  }, [loaded, page, onReady])

  const active = highlights.find((highlight) => highlight.fieldName === activeField)

  // Clicking a field on the right moves the viewer to the relevant page and
  // scrolls the source area into view (spec 5.2).
  useEffect(() => {
    if (!active) return
    setPage(active.page)
  }, [active])

  useEffect(() => {
    if (!active || loaded.page !== page) return
    const stage = stageRef.current
    const box = stage?.querySelector('[data-active="true"]')?.getBoundingClientRect()
    if (!stage || !box) return
    const viewport = stage.getBoundingClientRect()
    stage.scrollTo({
      left: stage.scrollLeft + box.x + box.width / 2 - viewport.x - viewport.width / 2,
      top: stage.scrollTop + box.y + box.height / 2 - viewport.y - viewport.height / 2,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    })
  }, [active, page, loaded, rotation, zoomIndex])

  const sideways = rotation % 180 !== 0
  const ratio = loaded.ratio

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
              onClick={() => {
                setPage(number)
                onSelectField(null)
              }}
              aria-current={number === page ? 'true' : undefined}
              className={`rounded-[6px] border p-1 transition-colors duration-[120ms] ${
                number === page ? 'border-accent' : 'border-rule hover:border-rule-2'
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/documents/${documentId}/pages/${number}/image?width=160`}
                alt={`Page ${number}`}
                className="w-full"
              />
              <span className="mono mt-1 block text-center text-2xs text-muted">{number}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-2 flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
            aria-label="Zoom out"
            disabled={zoomIndex === 0}
            className="btn btn--ghost btn--sm"
          >
            −
          </button>
          <span className="w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1))}
            aria-label="Zoom in"
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            className="btn btn--ghost btn--sm"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setRotation((value) => (value + 90) % 360)}
            className="btn btn--ghost btn--sm"
          >
            Rotate
          </button>
          <span className="mono ml-auto text-2xs text-muted">
            Page {page} of {pageCount || 1}
          </span>
        </div>

        <div
          ref={stageRef}
          className="flex-1 overflow-auto rounded-[10px] border border-rule bg-paper-3 p-4"
        >
          <div
            className="relative mx-auto"
            style={{
              width: `${(zoom * 100) / (sideways ? ratio : 1)}%`,
              aspectRatio: sideways ? 1 / ratio : ratio,
            }}
          >
            <div
              className="absolute left-1/2 top-1/2"
              style={{
                width: `${sideways ? ratio * 100 : 100}%`,
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/documents/${documentId}/pages/${page}/image?width=${RENDER_WIDTH}`}
                alt={`Page ${page}`}
                ref={measureImage}
                onLoad={(event) => measureImage(event.currentTarget)}
                className="block w-full shadow-sm"
              />

              {/* Coordinates are normalized to 0..1, so overlays use percentages
                and do not depend on zoom or render resolution. */}
              {onPage.map((highlight) => {
                const isActive = highlight.fieldName === activeField
                return (
                  <button
                    key={highlight.fieldName}
                    type="button"
                    data-active={isActive}
                    onClick={() => onSelectField(isActive ? null : highlight.fieldName)}
                    title={highlight.fieldName}
                    aria-label={`Source: ${highlight.fieldName}`}
                    className={`bbox ${isActive ? 'bbox--active' : ''}`}
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
    </div>
  )
}
