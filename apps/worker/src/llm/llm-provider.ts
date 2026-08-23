import type { ClassificationResponse, ExtractionResponse, FieldSpec } from '@docflow/shared'

/**
 * LLM stage contract (spec 6.3, 6.4). Provider responses must pass the contract's
 * Zod schema. Invalid JSON enters the provider's repair policy for up to two
 * retries, then raises LlmInvalidResponseError.
 */

export interface PageText {
  page: number
  text: string
}

export interface ClassifyInput {
  /** OCR text from the first two pages (spec 6.3). */
  pagesText: PageText[]
}

export interface ExtractInput {
  documentType: string
  fields: FieldSpec[]
  pagesText: PageText[]
}

export interface LlmProvider {
  readonly name: string
  /** true when the provider sends data outside the system. */
  readonly external: boolean
  classify(input: ClassifyInput): Promise<ClassificationResponse>
  extract(input: ExtractInput): Promise<ExtractionResponse>
}

/**
 * Response still invalid after repair. This is not transient: do not retry the
 * job; send the document to manual review without losing source data
 * (spec 6.4, §10).
 */
export class LlmInvalidResponseError extends Error {
  constructor(detail: string) {
    super(`LLM returned an invalid response after repair attempts: ${detail}`)
    this.name = 'LlmInvalidResponseError'
  }
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER')
