import { z } from 'zod'
import { CLASSIFIABLE_DOCUMENT_TYPES } from '../enums'
import { lineItemSchema } from './review'
import type { FieldSpec } from './schema'

/**
 * LLM response contracts. Accept a response only after schema validation
 * (spec 6.4); invalid JSON enters the repair policy.
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
  /** Indicators of multiple documents in one file (spec 6.3). */
  multi_document_suspected: z.boolean().default(false),
})
export type ClassificationResponse = z.infer<typeof classificationResponseSchema>

export const extractionResponseSchema = z.object({
  fields: z.array(
    z.object({
      name: z.string(),
      /** Verbatim document value, or null when missing (spec §9). */
      value: z.union([z.string(), z.array(lineItemSchema.strict()), z.null()]),
      /**
       * Verbatim source excerpt and page (spec 6.4). No evidence means no source.
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

/** Validate the selected schema without normalizing verbatim scalar values. */
export function extractionResponseSchemaFor(specs: FieldSpec[]) {
  const byName = new Map(specs.map((spec) => [spec.name, spec]))
  return extractionResponseSchema.superRefine((response, ctx) => {
    const seen = new Set<string>()
    response.fields.forEach((field, index) => {
      const spec = byName.get(field.name)
      const path = ['fields', index]
      if (!spec || seen.has(field.name)) {
        ctx.addIssue({ code: 'custom', path, message: 'Unknown or duplicate field name' })
      }
      seen.add(field.name)
      if (spec && field.value !== null && Array.isArray(field.value) !== (spec.type === 'array')) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'value'],
          message: `Expected ${spec.type === 'array' ? 'line-item array' : 'verbatim string'} or null`,
        })
      }
      if (field.value === null && field.evidence !== null) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'evidence'],
          message: 'Missing values must have null evidence',
        })
      }
    })
    for (const spec of specs) {
      if (!seen.has(spec.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields'],
          message: `Missing requested field: ${spec.name}`,
        })
      }
    }
  })
}
