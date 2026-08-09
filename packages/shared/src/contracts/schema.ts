import { z } from 'zod'
import { VALUE_TYPES, type DocumentType } from '../enums'

/**
 * Спецификация поля типа документа (ТЗ 6.4): хранится в
 * DocumentSchema.json_schema, версионируется вместе со схемой.
 */
export const fieldSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  type: z.enum(VALUE_TYPES),
  required: z.boolean(),
  critical: z.boolean(),
  /** Допустимые значения для type=enum. */
  enumValues: z.array(z.string()).optional(),
  /** Подсказка экстрактору: где искать и как выглядит значение. */
  hint: z.string().optional(),
})
export type FieldSpec = z.infer<typeof fieldSpecSchema>

export const schemaFieldsSchema = z.object({
  fields: z.array(fieldSpecSchema).max(15), // до 15 полей на тип (ТЗ §4)
})
export type SchemaFields = z.infer<typeof schemaFieldsSchema>

/** Пороги маршрутизации (ТЗ 6.3, 6.7); меняются через API администратора. */
export const thresholdsSchema = z.object({
  /** Ниже — документ получает тип unknown и уходит на ручной выбор. */
  autoClassify: z.number().min(0).max(1),
  /** Порог критичных полей: ниже — документ не проходит автоматически. */
  criticalFieldConfidence: z.number().min(0).max(1),
  /** Порог остальных полей — влияет на сортировку и подсветку. */
  fieldConfidence: z.number().min(0).max(1),
})
export type SchemaThresholds = z.infer<typeof thresholdsSchema>

export interface DocumentSchemaDto {
  id: string
  documentType: DocumentType
  version: number
  fields: FieldSpec[]
  thresholds: SchemaThresholds
  isActive: boolean
}
