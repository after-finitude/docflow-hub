import { z } from 'zod'
import { CLASSIFIABLE_DOCUMENT_TYPES } from '../enums'

/**
 * Контракты ответов LLM. Ответ принимается только после успешной валидации
 * этими схемами (ТЗ 6.4); невалидный JSON идёт в repair-политику.
 */

export const classificationResponseSchema = z.object({
  document_type: z.enum(CLASSIFIABLE_DOCUMENT_TYPES).nullable(),
  confidence: z.number().min(0).max(1),
  alternatives: z
    .array(
      z.object({
        document_type: z.enum(CLASSIFIABLE_DOCUMENT_TYPES),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(3)
    .default([]),
  /** Признаки нескольких документов в одном файле (ТЗ 6.3). */
  multi_document_suspected: z.boolean().default(false),
})
export type ClassificationResponse = z.infer<typeof classificationResponseSchema>

export const extractionResponseSchema = z.object({
  fields: z.array(
    z.object({
      name: z.string(),
      /** Дословное значение из документа; null — поле отсутствует (Missing, ТЗ §9). */
      value: z.string().nullable(),
      /**
       * Дословный фрагмент-источник и страница (ТЗ 6.4). Поле без evidence —
       * поле без источника.
       */
      evidence: z
        .object({
          text: z.string().min(1),
          page: z.number().int().min(1),
        })
        .nullable(),
    }),
  ),
})
export type ExtractionResponse = z.infer<typeof extractionResponseSchema>
