import type { SchemaThresholds } from '../contracts/schema'
import type { IssueSeverity } from '../enums'

/**
 * Маршрутизация после валидации (ТЗ 6.7): документ проходит автоматически
 * только если нет blocking-ошибок И все критичные поля выше порога.
 * Чистая функция — решение воспроизводимо и логируется вместе с версией правил.
 */

export interface RoutingField {
  name: string
  label: string
  isCritical: boolean
  confidence: number | null
}

export interface RoutingIssue {
  severity: IssueSeverity
  resolved: boolean
}

export interface RoutingDecision {
  /** true — документ может пройти без оператора. */
  auto: boolean
  blockingCount: number
  warningCount: number
  /** Критичные поля ниже порога — с фактическими значениями для журнала. */
  lowConfidenceFields: Array<{ name: string; confidence: number | null }>
  /** Понятные причины отправки на проверку. */
  reasons: string[]
}

export function decideRouting(
  fields: RoutingField[],
  issues: RoutingIssue[],
  thresholds: SchemaThresholds,
): RoutingDecision {
  const unresolved = issues.filter((issue) => !issue.resolved)
  const blockingCount = unresolved.filter((issue) => issue.severity === 'blocking').length
  const warningCount = unresolved.filter((issue) => issue.severity === 'warning').length

  // Критичное поле без значения (confidence = null) считается не прошедшим порог:
  // отсутствие значения не может быть основанием для автоматического прохода.
  const lowConfidenceFields = fields
    .filter((field) => field.isCritical)
    .filter((field) => (field.confidence ?? 0) < thresholds.criticalFieldConfidence)
    .map((field) => ({ name: field.name, confidence: field.confidence }))

  const reasons: string[] = []
  if (blockingCount > 0) {
    reasons.push(`Блокирующих ошибок: ${blockingCount}`)
  }
  if (lowConfidenceFields.length > 0) {
    const names = fields
      .filter((field) => lowConfidenceFields.some((low) => low.name === field.name))
      .map((field) => field.label)
      .join(', ')
    reasons.push(`Критичные поля ниже порога ${thresholds.criticalFieldConfidence}: ${names}`)
  }

  return {
    auto: blockingCount === 0 && lowConfidenceFields.length === 0,
    blockingCount,
    warningCount,
    lowConfidenceFields,
    reasons,
  }
}
