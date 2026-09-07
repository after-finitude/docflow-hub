import { MIN_OCR_CONFIDENCE } from '../constants'

/**
 * OCR quality assessment (spec §10): very poor scans require review with a warning.
 *
 * Pure function using page data only, making the decision reproducible and testable.
 */

export interface OcrPageQuality {
  pageNumber: number
  /** Mean block confidence, or null when the provider omitted it. */
  confidence: number | null
  textLength: number
  requiresReview?: boolean
}

export interface OcrQualityIssue {
  message: string
  expected: string
  actual: string
  /** Pages that triggered the warning, shown to the operator. */
  pages: number[]
}

export function assessOcrQuality(
  pages: OcrPageQuality[],
  minConfidence: number = MIN_OCR_CONFIDENCE,
): OcrQualityIssue | null {
  if (pages.length === 0) return null

  // A page with no recognized characters is the worst case; extraction has no input.
  const empty = pages.filter((page) => page.textLength === 0)
  // Missing confidence alone does not mean a poor scan; only a reported low value does.
  const weak = pages.filter(
    (page) => page.textLength > 0 && page.confidence !== null && page.confidence < minConfidence,
  )

  const uncalibrated = pages.filter((page) => page.requiresReview)
  if (empty.length === 0 && weak.length === 0 && uncalibrated.length === 0) return null

  const affected = [
    ...new Set([...empty, ...weak, ...uncalibrated].map((page) => page.pageNumber)),
  ].toSorted((a, b) => a - b)
  const worst = weak.reduce<number | null>(
    (min, page) => (min === null || page.confidence! < min ? page.confidence! : min),
    null,
  )

  const details =
    empty.length > 0
      ? `no text recognized on pages: ${empty.map((p) => p.pageNumber).join(', ')}`
      : weak.length > 0
        ? `OCR confidence ${worst!.toFixed(2)} on pages: ${weak.map((p) => p.pageNumber).join(', ')}`
        : `uncalibrated OCR text and coordinates on pages: ${uncalibrated.map((p) => p.pageNumber).join(', ')}`

  return {
    message: `Low OCR quality: ${details}. Review the values or replace the file`,
    expected: `confidence at least ${minConfidence.toFixed(2)} and non-empty text`,
    actual: details,
    pages: affected,
  }
}
