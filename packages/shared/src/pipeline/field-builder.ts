import { scoreConfidence, type ConfidenceSignals } from '../confidence/score'
import type { BoundingBox } from '../contracts/ocr'
import type { LineItem } from '../contracts/review'
import type { FieldSpec } from '../contracts/schema'
import type { ValueType } from '../enums'
import { matchEvidence, type EvidencePage } from '../matching/evidence-matcher'
import { normalizeByType } from '../normalize/values'

/**
 * Сборка поля из ответа LLM: нормализация, поиск источника (ТЗ 6.5) и расчёт
 * уверенности (ТЗ 6.7).
 *
 * Живёт в shared, потому что этим кодом пользуются два потребителя: процессор
 * извлечения в воркере и harness оценки качества (`npm run eval`). Оценка
 * обязана мерить тот же код, который работает в проде, а не его копию.
 */

/** Базовая уверенность извлечения до учёта остальных сигналов. */
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

  // Отсутствующее поле — null с признаком Missing, а не догадка (ТЗ §9).
  if (!llmField || llmField.value === null) {
    return {
      ...base,
      rawValue: null,
      normalizedValue: null,
      confidence: null,
      confidenceReason: 'Значение отсутствует в документе',
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

  // Поле без evidence — поле без источника (ТЗ 6.4).
  const match = llmField.evidence
    ? matchEvidence(llmField.evidence.text, llmField.evidence.page, pages)
    : ({ found: false } as const)

  // Сигналы сохраняются: перевалидация пересчитывает уверенность из них
  // заново, а не накладывает штраф поверх уже посчитанного значения.
  const signals: ConfidenceSignals = {
    extraction: EXTRACTION_BASE_CONFIDENCE,
    ocr: match.found ? match.ocrConfidence : null,
    sourceFound: match.found,
    pageMismatch: match.found ? match.pageMismatch : false,
  }
  const score = scoreConfidence(signals)

  const reasons = [...score.reasons]
  if (normalizedValue === null && !isArray) {
    reasons.push(`Не удалось привести значение к типу ${spec.type}`)
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
