import type { OcrBlock } from '@docflow/shared'

/**
 * OCR stage contract (spec 6.2), shaped after Google Cloud Vision: polygon
 * blocks become rectangles with per-block confidence. The mock returns the same shape.
 */

export interface OcrPageResult {
  pageNumber: number
  /** Page dimensions used to normalize bbox values (raster pixels or PDF points). */
  width: number
  height: number
  text: string
  /** Mean block confidence, or null when there are no blocks. */
  confidence: number | null
  blocks: OcrBlock[]
  /** Whether the page was sent to an external provider, for the transfer log (spec §11). */
  sentToProvider: boolean
  /** A visually blank raster is distinct from an OCR failure to find text. */
  blank?: boolean
  /** Correction applied to the OCR copy only; persisted boxes use original coordinates. */
  rotationDegrees?: number
  providerCalls?: number
}

export interface OcrResult {
  pages: OcrPageResult[]
}

export interface OcrProvider {
  readonly name: string
  /** true when the provider sends data outside the system. */
  readonly external: boolean
  recognize(buffer: Buffer, mimeType: string): Promise<OcrResult>
}

export const OCR_PROVIDER = Symbol('OCR_PROVIDER')
