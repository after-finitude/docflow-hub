import { z } from 'zod'
import { VALUE_TYPES, type DocumentType } from '../enums'
import {
  validationRuleSchema,
  EXTERNAL_RULE_IDS,
  INVOICE_NUMBER_UNIQUE_RULE,
  type ValidationRule,
} from '../validation/rules'
import type { ExportMapping } from '../export/canonical'

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
  exportMapping: ExportMapping
}

/** Complete versioned configuration accepted by the administrator API. */
export const schemaConfigurationSchema = schemaFieldsSchema
  .extend({
    thresholds: thresholdsSchema,
    exportMapping: z
      .array(
        z
          .object({
            column: z.string().trim().min(1),
            source: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .superRefine((config, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    const fields = new Map(config.fields.map((field) => [field.name, field]))
    if (!fields.size) issue('At least one field is required')
    if (fields.size !== config.fields.length) issue('Field names must be unique')
    // One table per schema; the reserved transactions field uses bank-statement rows.
    if (config.fields.filter((field) => field.type === 'array').length > 1)
      issue('Only one table array is supported')
    for (const field of config.fields) {
      if (field.name === 'transactions' && field.type !== 'array')
        issue('The transactions field must be an array')
      if (field.type === 'enum' && !field.enumValues?.length)
        issue(`Enum field ${field.name} requires enumValues`)
    }
    const ids = new Set<string>([
      ...EXTERNAL_RULE_IDS,
      INVOICE_NUMBER_UNIQUE_RULE,
      'document_type_known',
    ])
    for (const rule of config.rules) {
      if (ids.has(rule.id) || rule.id.startsWith('required:') || rule.id.startsWith('type:'))
        issue(`Duplicate or reserved rule id: ${rule.id}`)
      ids.add(rule.id)
      const names =
        rule.type === 'statement_balance'
          ? [rule.field, rule.opening, rule.closing, rule.creditTotal, rule.debitTotal]
          : rule.type === 'sum'
            ? [rule.target, ...rule.operands]
            : rule.type === 'number_compare'
              ? [rule.field, rule.other]
              : rule.type === 'date_order'
                ? [rule.field, rule.notEarlierThan]
                : [rule.field]
      for (const name of names) {
        const field = fields.get(name)
        if (!field) {
          issue(`Unknown rule field: ${name}`)
          continue
        }
        const expected =
          rule.type === 'statement_balance'
            ? [name === rule.field ? 'array' : 'number']
            : ['sum', 'number_range', 'number_compare'].includes(rule.type)
              ? ['number']
              : ['date_order', 'date_offset'].includes(rule.type)
                ? ['date']
                : rule.type === 'array_or_absent'
                  ? ['array']
                  : ['string', 'enum', 'currency']
        if (!expected.includes(field.type)) issue(`Rule ${rule.id} is incompatible with ${name}`)
      }
      if (rule.type === 'regex') {
        try {
          RegExp(rule.pattern)
        } catch {
          issue(`Invalid regex in ${rule.id}`)
        }
      }
      if (
        rule.type === 'number_range' &&
        rule.min !== undefined &&
        rule.max !== undefined &&
        rule.min > rule.max
      )
        issue(`Invalid range in ${rule.id}`)
      if (
        rule.type === 'date_offset' &&
        rule.minDaysFromToday !== undefined &&
        rule.maxDaysFromToday !== undefined &&
        rule.minDaysFromToday > rule.maxDaysFromToday
      )
        issue(`Invalid date range in ${rule.id}`)
    }
    const columns = new Set<string>()
    const metadata = new Set([
      'documentId',
      'documentType',
      'originalFilename',
      'checksum',
      'receivedAt',
      'approvedAt',
      'lineItemCount',
    ])
    for (const entry of config.exportMapping) {
      if (columns.has(entry.column)) issue(`Duplicate export column: ${entry.column}`)
      columns.add(entry.column)
      const field = entry.source.startsWith('field:')
        ? fields.get(entry.source.slice(6))
        : undefined
      if (
        !(field && field.type !== 'array') &&
        !(entry.source.startsWith('meta:') && metadata.has(entry.source.slice(5)))
      )
        issue(`Unsupported export source: ${entry.source}`)
    }
  })
export type SchemaConfiguration = z.infer<typeof schemaConfigurationSchema>
