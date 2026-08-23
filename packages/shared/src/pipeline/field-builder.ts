import { scoreConfidence, type ConfidenceSignals } from '../confidence/score'
import type { BoundingBox } from '../contracts/ocr'
import type { LineItem } from '../contracts/review'
import type { FieldSpec } from '../contracts/schema'
import type { ValueType } from '../enums'
import { matchEvidence, type EvidencePage } from '../matching/evidence-matcher'
import { normalizeByType } from '../normalize/values'

/**
 * Build a field from the LLM response: normalize, locate its source (spec 6.5),
 * and calculate confidence (spec 6.7).
 *
 * Shared by the extraction worker and `npm run eval` so evaluation measures the
 * production code rather than a copy.
 */

/** Base extraction confidence before other signals. */
export const EXTRACTION_BASE_CONFIDENCE = 0.9

export interface LlmFieldValue {
  value: string | LineItem[] | null
  evidence: { text: string; page: number } | null
}

export interface ExtractedField {
  name: string
  valueType: ValueType
  rawValue: string | null
  normalizedValue: unknown
  confidence: number | null
  confidenceReason: string | null
  confidenceSignals: ConfidenceSignals | null
  sourcePage: number | null
  sourceBbox: BoundingBox | null
  sourceFound: boolean
  isCritical: boolean
}

export function buildExtractedField(
  spec: FieldSpec,
  llmField: LlmFieldValue | undefined,
  pages: EvidencePage[],
): ExtractedField {
  const base = {
    name: spec.name,
    valueType: spec.type,
    isCritical: spec.critical,
  }

  // A missing field is null with a Missing marker, never a guess (spec §9).
  if (!llmField || llmField.value === null) {
    return {
      ...base,
      rawValue: null,
      normalizedValue: null,
      confidence: null,
      confidenceReason: 'Value is missing from the document',
      confidenceSignals: null,
      sourcePage: null,
      sourceBbox: null,
      sourceFound: false,
    }
  }

  const isArray = Array.isArray(llmField.value)
  const rawValue = isArray ? JSON.stringify(llmField.value) : (llmField.value as string)
  const normalizedValue = isArray
    ? llmField.value
    : normalizeByType(llmField.value as string, spec.type)

  // A field without evidence has no source (spec 6.4).
  const match = llmField.evidence
    ? matchEvidence(llmField.evidence.text, llmField.evidence.page, pages)
    : ({ found: false } as const)

  // Persist signals so revalidation recalculates instead of stacking penalties.
  const signals: ConfidenceSignals = {
    extraction: EXTRACTION_BASE_CONFIDENCE,
    ocr: match.found ? match.ocrConfidence : null,
    sourceFound: match.found,
    pageMismatch: match.found ? match.pageMismatch : false,
  }
  const score = scoreConfidence(signals)

  const reasons = [...score.reasons]
  if (normalizedValue === null && !isArray) {
    reasons.push(`Could not convert the value to type ${spec.type}`)
  }

  return {
    ...base,
    rawValue,
    normalizedValue,
    confidence: score.confidence,
    confidenceReason: reasons.length ? reasons.join('; ') : null,
    confidenceSignals: signals,
    sourcePage: match.found ? match.page : null,
    sourceBbox: match.found ? match.bbox : null,
    sourceFound: match.found,
  }
}
