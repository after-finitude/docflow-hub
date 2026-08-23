import { z } from 'zod'
import { VALUE_TYPES, type DocumentType } from '../enums'
import { validationRuleSchema, type ValidationRule } from '../validation/rules'

/**
 * Document-type field specification (spec 6.4), stored and versioned in
 * DocumentSchema.json_schema.
 */
export const fieldSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  type: z.enum(VALUE_TYPES),
  required: z.boolean(),
  critical: z.boolean(),
  /** Allowed values for type=enum. */
  enumValues: z.array(z.string()).optional(),
  /** Hint to the extractor describing where and how to find the value. */
  hint: z.string().optional(),
})
export type FieldSpec = z.infer<typeof fieldSpecSchema>

/**
 * DocumentSchema.json_schema content: fields and validation rules versioned
 * together (spec 6.6).
 */
export const schemaFieldsSchema = z.object({
  fields: z.array(fieldSpecSchema).max(15), // Up to 15 fields per type (spec §4).
  rules: z.array(validationRuleSchema).default([]),
})
export type SchemaFields = z.infer<typeof schemaFieldsSchema>

/** Routing thresholds (spec 6.3, 6.7), managed through the administrator API. */
export const thresholdsSchema = z.object({
  /** Below this, assign unknown and require manual type selection. */
  autoClassify: z.number().min(0).max(1),
  /** Critical-field threshold below which automatic approval is blocked. */
  criticalFieldConfidence: z.number().min(0).max(1),
  /** Other-field threshold used for sorting and highlighting. */
  fieldConfidence: z.number().min(0).max(1),
})
export type SchemaThresholds = z.infer<typeof thresholdsSchema>

export interface DocumentSchemaDto {
  id: string
  documentType: DocumentType
  version: number
  fields: FieldSpec[]
  rules: ValidationRule[]
  thresholds: SchemaThresholds
  isActive: boolean
}
