import type { ClassificationResponse, ExtractionResponse, FieldSpec } from '@docflow/shared'

/**
 * Контракт LLM-этапов (ТЗ 6.3, 6.4). Ответ провайдера обязан пройти zod-схему
 * контракта; невалидный JSON — repair-политика внутри провайдера (до 2
 * повторов), затем LlmInvalidResponseError.
 */

export interface PageText {
  page: number
  text: string
}

export interface ClassifyInput {
  /** OCR-текст первых двух страниц (ТЗ 6.3). */
  pagesText: PageText[]
}

export interface ExtractInput {
  documentType: string
  fields: FieldSpec[]
  pagesText: PageText[]
}

export interface LlmProvider {
  readonly name: string
  /** true — провайдер отправляет данные за пределы системы. */
  readonly external: boolean
  classify(input: ClassifyInput): Promise<ClassificationResponse>
  extract(input: ExtractInput): Promise<ExtractionResponse>
}

/**
 * Ответ не прошёл валидацию после repair-политики. Не транзиентная ошибка:
 * задача не ретраится, документ уходит в ручную обработку без потери
 * исходных данных (ТЗ 6.4, §10).
 */
export class LlmInvalidResponseError extends Error {
  constructor(detail: string) {
    super(`LLM вернул невалидный ответ после repair-повторов: ${detail}`)
    this.name = 'LlmInvalidResponseError'
  }
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER')
