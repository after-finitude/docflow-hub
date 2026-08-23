import { z } from 'zod'
import { ISSUE_SEVERITIES } from '../enums'

/**
 * Validation rules (spec 6.6), stored and versioned in type-schema configuration.
 *
 * Required fields come from FieldSpec.required; regex covers patterns;
 * date_offset and date_order cover date ranges; enum covers normalized currency
 * and reference values; sum covers arithmetic; number_compare covers field relations.
 */

const severity = z.enum(ISSUE_SEVERITIES)
const base = { id: z.string().min(1), severity, message: z.string().optional() }

export const validationRuleSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('regex'), field: z.string(), pattern: z.string() }),
  z.object({
    ...base,
    type: z.literal('enum'),
    field: z.string(),
    values: z.array(z.string()).min(1),
  }),
  z.object({
    ...base,
    type: z.literal('number_range'),
    field: z.string(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('number_compare'),
    field: z.string(),
    operator: z.enum(['gte', 'lte', 'gt', 'lt']),
    other: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('date_offset'),
    field: z.string(),
    /** No later than today + N days (spec §13: invoice_date). */
    maxDaysFromToday: z.number().int().optional(),
    minDaysFromToday: z.number().int().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('date_order'),
    field: z.string(),
    /** Date no earlier than this field (spec §13: due_date ≥ invoice_date). */
    notEarlierThan: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('sum'),
    /** target ≈ sum of operands within tolerance (spec §13: blocking). */
    target: z.string(),
    operands: z.array(z.string()).min(2),
    tolerance: z.number().nonnegative(),
  }),
  z.object({ ...base, type: z.literal('array_or_absent'), field: z.string() }),
])

export type ValidationRule = z.infer<typeof validationRuleSchema>

/** invoice_number uniqueness rule, the only cross-document check (spec §9). */
export const INVOICE_NUMBER_UNIQUE_RULE = 'invoice_number_unique'

/** OCR quality warning set by the OCR stage (spec §10). */
export const OCR_QUALITY_RULE = 'ocr_quality_low'

/**
 * External rules preserved by revalidation: classification sets the multiple-
 * document warning (spec 6.3), and OCR sets the quality warning (spec §10).
 */
export const EXTERNAL_RULE_IDS = ['multi_document_suspected', OCR_QUALITY_RULE] as const

/**
 * Rules that force review even at warning severity: suspected multiple documents
 * (spec 6.3) and very poor scan quality (spec §10).
 */
export const FORCE_REVIEW_RULE_IDS: readonly string[] = [
  'multi_document_suspected',
  OCR_QUALITY_RULE,
]
