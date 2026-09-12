import { NO_SOURCE_CONFIDENCE_CAP } from '../constants'
import type { SchemaThresholds } from '../contracts/schema'

export function capSourceConfidence(
  confidence: number | null,
  sourceFound: boolean,
): number | null {
  return confidence === null || sourceFound
    ? confidence
    : Math.min(NO_SOURCE_CONFIDENCE_CAP, confidence)
}

export function fieldConfidenceThreshold(
  isCritical: boolean,
  thresholds: SchemaThresholds | null,
): number {
  return isCritical
    ? (thresholds?.criticalFieldConfidence ?? 0.8)
    : (thresholds?.fieldConfidence ?? 0.6)
}

/**
 * Final field confidence from extraction, source-area OCR, source presence,
 * and optional validation signals (spec 6.7).
 */
export interface ConfidenceSignals {
  /** Base extraction confidence (0..1). */
  extraction: number
  /** Mean OCR confidence in the source area, or null when no source was found. */
  ocr: number | null
  sourceFound: boolean
  /** Source page differs from the page reported by the LLM (spec 6.5.4). */
  pageMismatch?: boolean
  /** Whether this field has a blocking validation issue. */
  failedValidation?: boolean
}

export interface ConfidenceScore {
  confidence: number
  /** Reduction reasons stored in confidence_reason (spec 6.4). */
  reasons: string[]
}

export function scoreConfidence(signals: ConfidenceSignals): ConfidenceScore {
  const reasons: string[] = []

  if (!signals.sourceFound) {
    // A field without a source cannot have high confidence (spec §9).
    const confidence = Math.min(NO_SOURCE_CONFIDENCE_CAP, signals.extraction * 0.7)
    reasons.push('Value source not found in the document')
    return { confidence: round(confidence), reasons }
  }

  // Source-area OCR confidence weights the base score but is not equivalent to
  // business confidence (spec 6.2), so include it only proportionally.
  let confidence = signals.extraction * (0.6 + 0.4 * (signals.ocr ?? 0))
  if ((signals.ocr ?? 1) < 0.7) reasons.push('OCR accuracy in the source area requires review')

  if (signals.pageMismatch) {
    confidence *= 0.85
    reasons.push('Source found on a different page than the model reported')
  }

  if (signals.failedValidation) {
    confidence *= 0.7
    reasons.push('Value failed validation')
  }

  return { confidence: round(confidence), reasons }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
