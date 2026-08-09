import { NO_SOURCE_CONFIDENCE_CAP } from '../constants'

/**
 * Итоговая уверенность поля из нескольких сигналов (ТЗ 6.7): уверенность
 * извлечения, OCR по области источника, наличие источника. Сигнал валидации
 * добавит этап 5 — функция принимает его уже сейчас как необязательный.
 */
export interface ConfidenceSignals {
  /** Базовая уверенность извлечения (0..1). */
  extraction: number
  /** Средняя OCR-уверенность области источника; null — источник не найден. */
  ocr: number | null
  sourceFound: boolean
  /** Страница источника не совпала с заявленной LLM (ТЗ 6.5 п.4). */
  pageMismatch?: boolean
  /** Есть blocking-ошибка валидации по этому полю (этап 5). */
  failedValidation?: boolean
}

export interface ConfidenceScore {
  confidence: number
  /** Причины снижения — для confidence_reason (ТЗ 6.4). */
  reasons: string[]
}

export function scoreConfidence(signals: ConfidenceSignals): ConfidenceScore {
  const reasons: string[] = []

  if (!signals.sourceFound) {
    // Поле без найденного источника не может иметь высокую уверенность (ТЗ §9).
    const confidence = Math.min(NO_SOURCE_CONFIDENCE_CAP, signals.extraction * 0.7)
    reasons.push('Источник значения не найден в документе')
    return { confidence: round(confidence), reasons }
  }

  // OCR-уверенность области взвешивает базу: чистый скан почти не снижает,
  // мутный — ощутимо. OCR confidence не приравнивается к бизнес-уверенности
  // (ТЗ 6.2), поэтому входит долей, а не множителем напрямую.
  let confidence = signals.extraction * (0.6 + 0.4 * (signals.ocr ?? 0))
  if ((signals.ocr ?? 1) < 0.7) reasons.push('Низкое качество распознавания в области источника')

  if (signals.pageMismatch) {
    confidence *= 0.85
    reasons.push('Источник найден не на той странице, которую указала модель')
  }

  if (signals.failedValidation) {
    confidence *= 0.7
    reasons.push('Значение не прошло проверку')
  }

  return { confidence: round(confidence), reasons }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
