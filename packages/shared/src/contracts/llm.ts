import { z } from 'zod'
import { CLASSIFIABLE_DOCUMENT_TYPES } from '../enums'

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
      value: z.string().nullable(),
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
