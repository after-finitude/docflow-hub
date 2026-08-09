import {
  classificationResponseSchema,
  extractionResponseSchema,
  type ClassificationResponse,
  type ExtractionResponse,
} from '@docflow/shared'
import { Injectable, Logger } from '@nestjs/common'
import { UnrecoverableError } from 'bullmq'
import type { ZodType } from 'zod'
import {
  LlmInvalidResponseError,
  type ClassifyInput,
  type ExtractInput,
  type LlmProvider,
  type PageText,
} from './llm-provider'

/** Repair-политика невалидного JSON: до 2 повторов (ТЗ 6.4, 6.10). */
const MAX_REPAIRS = 2

export interface OpenAiCompatibleOptions {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Любой OpenAI-совместимый chat-completions endpoint: DeepSeek, OpenAI и др.
 * Модель и адрес задаются конфигурацией — смена провайдера не трогает код.
 * Используется response_format json_object: строгие json-схемы поддерживают
 * не все совместимые провайдеры, а zod-валидация с repair покрывает разницу.
 */
@Injectable()
export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name: string
  readonly external = true

  private readonly logger = new Logger(OpenAiCompatibleLlmProvider.name)

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.name = `openai-compatible:${options.model}`
  }

  async classify(input: ClassifyInput): Promise<ClassificationResponse> {
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
    )
  }

  async extract(input: ExtractInput): Promise<ExtractionResponse> {
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
      extractionResponseSchema,
    )
  }

  /** Запрос с валидацией ответа и repair-циклом. */
  private async complete<T>(messages: ChatMessage[], schema: ZodType<T>): Promise<T> {
    const conversation = [...messages]
    let lastError = ''

    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      const raw = await this.request(conversation)

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        lastError = `не JSON: ${error instanceof Error ? error.message : String(error)}`
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

      lastError = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      conversation.push(
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: `Your previous answer failed validation: ${lastError}. Return the corrected JSON only.`,
        },
      )
      this.logger.warn(
        `Ответ LLM не прошёл схему (repair ${attempt + 1}/${MAX_REPAIRS}): ${lastError}`,
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
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error) {
      // Сеть и таймаут — транзиентные: политика повторов BullMQ (ТЗ 6.10).
      throw error instanceof Error ? error : new Error(String(error))
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 300)
      const message = `LLM API ${response.status}: ${body}`
      // 429 и 5xx лечатся повтором; остальные 4xx (ключ, модель) — нет.
      if (response.status === 429 || response.status >= 500) throw new Error(message)
      throw new UnrecoverableError(message)
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw new Error('LLM API вернул ответ без содержимого')
    return content
  }
}

function renderPages(pagesText: PageText[]): string {
  return pagesText.map((page) => `[Page ${page.page}]\n${page.text}`).join('\n\n')
}
