import { MIN_OCR_CONFIDENCE } from '../constants'

/**
 * Оценка качества распознавания (ТЗ §10: скан очень низкого качества уходит
 * на проверку с предупреждением об OCR quality).
 *
 * Чистая функция: решение принимается по данным страниц, без обращения к БД,
 * поэтому оно воспроизводимо и проверяется тестами.
 */

export interface OcrPageQuality {
  pageNumber: number
  /** Средняя уверенность по блокам; null — провайдер её не сообщил. */
  confidence: number | null
  textLength: number
}

export interface OcrQualityIssue {
  message: string
  expected: string
  actual: string
  /** Страницы, вызвавшие предупреждение — для сообщения оператору. */
  pages: number[]
}

export function assessOcrQuality(
  pages: OcrPageQuality[],
  minConfidence: number = MIN_OCR_CONFIDENCE,
): OcrQualityIssue | null {
  if (pages.length === 0) return null

  // Страница без единого распознанного символа — худший случай: дальше
  // извлекать нечего. Уверенность при этом обычно не сообщается вовсе.
  const empty = pages.filter((page) => page.textLength === 0)
  // Отсутствие уверенности само по себе не признак плохого скана: провайдер
  // мог её не вернуть. Низкой считается только сообщённая и малая.
  const weak = pages.filter(
    (page) => page.textLength > 0 && page.confidence !== null && page.confidence < minConfidence,
  )

  if (empty.length === 0 && weak.length === 0) return null

  const affected = [...empty, ...weak].map((page) => page.pageNumber).toSorted((a, b) => a - b)
  const worst = weak.reduce<number | null>(
    (min, page) => (min === null || page.confidence! < min ? page.confidence! : min),
    null,
  )

  const details =
    empty.length > 0
      ? `текст не распознан на страницах: ${empty.map((p) => p.pageNumber).join(', ')}`
      : `уверенность распознавания ${worst!.toFixed(2)} на страницах: ${weak
          .map((p) => p.pageNumber)
          .join(', ')}`

  return {
    message: `Низкое качество распознавания: ${details}. Проверьте значения или замените файл`,
    expected: `уверенность не ниже ${minConfidence.toFixed(2)} и непустой текст`,
    actual: details,
    pages: affected,
  }
}
