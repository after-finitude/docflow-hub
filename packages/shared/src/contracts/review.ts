import { z } from 'zod'

/**
 * Контракты Review Workspace (ТЗ 5.2).
 */

/** Простые line items: плоская таблица без вложенности (ТЗ §4). */
export const lineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  amount: z.number().nullable(),
})
export type LineItem = z.infer<typeof lineItemSchema>

/**
 * Правка значения поля. Строка — для скалярных полей (нормализация выполняется
 * на сервере), массив — для line items, null — явная очистка значения.
 */
export const updateFieldRequestSchema = z.object({
  value: z.union([z.string(), z.array(lineItemSchema), z.null()]),
})
export type UpdateFieldRequest = z.infer<typeof updateFieldRequestSchema>

/** Причины отклонения из списка + свободный комментарий (ТЗ 5.2). */
export const REJECT_REASONS = [
  'poor_scan_quality',
  'wrong_document_type',
  'duplicate',
  'incomplete_document',
  'not_our_document',
  'other',
] as const
export type RejectReason = (typeof REJECT_REASONS)[number]

export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  poor_scan_quality: 'Низкое качество скана',
  wrong_document_type: 'Неподходящий тип документа',
  duplicate: 'Дубликат',
  incomplete_document: 'Документ неполный',
  not_our_document: 'Документ не наш',
  other: 'Другое',
}

export const rejectRequestSchema = z.object({
  reason: z.enum(REJECT_REASONS),
  comment: z.string().max(1000).optional(),
})
export type RejectRequest = z.infer<typeof rejectRequestSchema>

/** Фильтры списка полей в правой колонке (ТЗ 5.2). */
export const FIELD_FILTERS = ['all', 'missing', 'low_confidence', 'invalid'] as const
export type FieldFilter = (typeof FIELD_FILTERS)[number]

export const FIELD_FILTER_LABELS: Record<FieldFilter, string> = {
  all: 'Все',
  missing: 'Отсутствующие',
  low_confidence: 'Низкая уверенность',
  invalid: 'Ошибки валидации',
}
