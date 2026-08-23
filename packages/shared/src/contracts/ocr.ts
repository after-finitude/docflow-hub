/**
 * Value-source geometry normalized to page dimensions (0..1), allowing the
 * frontend to scale overlays independently of render DPI (spec 5.2).
 */
export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

/** Text block from the OCR provider, spec 6.2. */
export interface OcrBlock {
  text: string
  bbox: BoundingBox
  confidence: number
}

/** Document page with OCR results returned by GET /documents/{id}/pages. */
export interface DocumentPage {
  pageNumber: number
  /** null before OCR runs; empty string for a blank page. */
  text: string | null
  confidence: number | null
  width: number | null
  height: number | null
  blocks: OcrBlock[]
}
