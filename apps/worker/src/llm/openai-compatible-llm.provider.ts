import {
  classificationResponseSchema,
  extractionResponseSchemaFor,
  type ClassificationResponse,
  type ExtractionResponse,
} from '@docflow/shared'
import { Injectable, Logger } from '@nestjs/common'
import { UnrecoverableError } from 'bullmq'
import type { ZodType } from 'zod'
import {
  auditedExternalCall,
  type ExternalCallRecorder,
  type ExternalCallDetails,
} from '@docflow/core'
import {
  LlmInvalidResponseError,
  type ClassifyInput,
  type ExtractInput,
  type LlmProvider,
  type PageText,
} from './llm-provider'

/** Invalid JSON or schema repair policy: up to two retries (spec 6.4, 6.10). */
const MAX_REPAIRS = 2

export interface OpenAiCompatibleOptions {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  maxTokens?: number
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content:
    | string
    | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
}

/**
 * Any OpenAI-compatible chat-completions endpoint. Configuration selects the
 * model and URL without code changes. response_format json_object works across
 * providers, while Zod validation and repair cover inconsistent strict-schema support.
 */
@Injectable()
export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name: string
  readonly external = true

  private readonly logger = new Logger(OpenAiCompatibleLlmProvider.name)

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.name = `openai-compatible:${options.model}`
  }

  async classify(
    input: ClassifyInput,
    record?: ExternalCallRecorder,
  ): Promise<ClassificationResponse> {
    const system = [
      'You classify business documents. Allowed types: invoice, bank_statement, tax_letter, contract.',
      'Respond with JSON only: {"document_type": <type or null>, "confidence": 0..1,',
      '"alternatives": [{"document_type", "confidence"}] (up to 3, may be empty),',
      '"multi_document_suspected": boolean}.',
      'Set multi_document_suspected=true if the file looks like several documents merged:',
      'supplier changes, repeated headers, unrelated page numbering.',
      'If none of the types fit, use document_type=null with low confidence. Do not guess.',
    ].join(' ')

    return this.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: renderPages(input.pagesText) },
      ],
      classificationResponseSchema,
      { purpose: 'classification', pages: input.pagesText.map((p) => p.page), fields: [] },
      record,
    )
  }

  async extract(input: ExtractInput, record?: ExternalCallRecorder): Promise<ExtractionResponse> {
    const fieldLines = input.fields.map((field) => {
      const parts = [
        `- name: ${field.name}; type: ${field.type}; label: "${field.label}"`,
        field.enumValues?.length ? `allowed: ${field.enumValues.join(', ')}` : '',
        field.hint ? `hint: ${field.hint}` : '',
      ]
      return parts.filter(Boolean).join('; ')
    })

    const system = [
      `You extract fields from a ${input.documentType} document.`,
      'Respond with JSON only: {"fields": [{"name", "value", "evidence": {"text", "page"} | null}]}.',
      'Rules:',
      '1. "value" is the VERBATIM string as written in the document. Do not normalize or translate.',
      '2. For array fields (line items) "value" is an array of {"description", "quantity", "unit_price", "amount"}.',
      'Description is a string; quantity, unit_price, and amount are numbers or null when absent. No nested or extra properties.',
      '3. "evidence" is the verbatim text fragment from the document that contains the value, with its page number.',
      '4. If a field is absent, return value=null and evidence=null. NEVER invent values.',
      '5. Return every requested field exactly once.',
      'Fields to extract:',
      ...fieldLines,
    ].join('\n')

    return this.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: renderPages(input.pagesText) },
      ],
      extractionResponseSchemaFor(input.fields),
      {
        purpose: 'extraction',
        pages: input.pagesText.map((p) => p.page),
        fields: input.fields.map((f) => f.name),
      },
      record,
    )
  }

  /** Request with response validation and a repair loop. */
  async complete<T>(
    messages: ChatMessage[],
    schema: ZodType<T>,
    details: Omit<ExternalCallDetails, 'attempt'>,
    record?: ExternalCallRecorder,
  ): Promise<T> {
    const conversation = [...messages]
    let lastError = ''

    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      const raw = await auditedExternalCall(record, { ...details, attempt: attempt + 1 }, () =>
        this.request(conversation),
      )

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        lastError = 'response is not valid JSON'
        conversation.push(
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content: `Your previous answer is not valid JSON (${lastError}). Return the corrected JSON only.`,
          },
        )
        continue
      }

      const result = schema.safeParse(parsed)
      if (result.success) return result.data

      // Provider-controlled values and property names must never enter logs/errors.
      lastError = `response schema errors: ${[...new Set(result.error.issues.map((issue) => issue.code))].join(', ')}`
      conversation.push(
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: `Your previous answer failed validation: ${lastError}. Return the corrected JSON only.`,
        },
      )
      this.logger.warn(
        `LLM response failed schema validation (attempt ${attempt + 1}/${MAX_REPAIRS + 1}): ${lastError}`,
      )
    }

    throw new LlmInvalidResponseError(lastError)
  }

  private async request(messages: ChatMessage[]): Promise<string> {
    let response: Response
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          temperature: 0,
          max_tokens: this.options.maxTokens ?? 8192,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch {
      // Network failures and timeouts are transient; BullMQ retries them (spec 6.10).
      throw new Error('LLM API network request failed')
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      const message = `LLM API returned HTTP ${response.status}`
      // Retry 429 and 5xx responses, but not other 4xx errors such as key or model failures.
      if (response.status === 429 || response.status >= 500) throw new Error(message)
      throw new UnrecoverableError(message)
    }

    const payload = (await response.json().catch(() => {
      throw new Error('LLM API returned malformed transport JSON')
    })) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    }
    if (payload.choices?.[0]?.finish_reason === 'length')
      throw new LlmInvalidResponseError('response exceeded output token limit')
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content)
      throw new Error('LLM API returned an empty or invalid response')
    return content
  }
}

function renderPages(pagesText: PageText[]): string {
  return pagesText.map((page) => `[Page ${page.page}]\n${page.text}`).join('\n\n')
}
