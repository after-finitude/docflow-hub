import type { ClassificationResponse, ExtractionResponse } from '@docflow/shared'
import { Injectable } from '@nestjs/common'
import type { ClassifyInput, ExtractInput, LlmProvider } from './llm-provider'

/**
 * Детерминированный LLM без внешних вызовов.
 *
 * Классификация — по ключевым словам; извлечение — по шаблону «Метка: значение»,
 * которым размечены демо-документы (этап 8) и фикстуры. Evidence всегда —
 * дословная строка из текста страницы, поэтому матчер находит её штатно.
 */
@Injectable()
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock'
  readonly external = false

  async classify(input: ClassifyInput): Promise<ClassificationResponse> {
    const text = input.pagesText
      .map((page) => page.text)
      .join('\n')
      .toLowerCase()

    // Паттерны заголовочные, а не пословные: слово «tax» есть в каждом
    // инвойсе, и наивное правило уводило бы инвойсы в unknown.
    const rules: Array<{ type: ClassificationResponse['document_type']; pattern: RegExp }> = [
      { type: 'invoice', pattern: /^\s*(invoice|счёт|счет)\b/m },
      {
        type: 'bank_statement',
        pattern: /bank statement|выписка по счет|opening balance|входящий остаток/,
      },
      { type: 'tax_letter', pattern: /tax (office|authority|notice)|налоговая|ифнс|уведомление/ },
      { type: 'contract', pattern: /^\s*(contract|договор|соглашение|agreement)\b/m },
    ]

    const matched = rules.filter((rule) => rule.pattern.test(text))
    if (matched.length === 0) {
      return {
        document_type: null,
        confidence: 0,
        alternatives: [],
        multi_document_suspected: false,
      }
    }

    // Повторная шапка INVOICE дальше по тексту — признак нескольких документов
    // в одном файле; используется негативным сценарием демо-набора.
    const multiDocument = (text.match(/^\s*invoice\s*$/gm) ?? []).length > 1

    return {
      document_type: matched[0]!.type,
      confidence: matched.length === 1 ? 0.95 : 0.6,
      alternatives: matched
        .slice(1, 4)
        .map((rule) => ({ document_type: rule.type!, confidence: 0.4 })),
      multi_document_suspected: multiDocument,
    }
  }

  async extract(input: ExtractInput): Promise<ExtractionResponse> {
    if (input.documentType !== 'invoice') {
      // Для остальных типов mock честно возвращает Missing по каждому полю:
      // «не выдумывать» (ТЗ §9) относится и к mock-реализации.
      return {
        fields: input.fields.map((field) => ({ name: field.name, value: null, evidence: null })),
      }
    }

    const patterns: Record<string, RegExp> = {
      supplier_name: /^Supplier:\s*(.+)$/m,
      invoice_number: /^Invoice No:\s*(\S+)$/m,
      invoice_date: /^Date:\s*([\d./-]+)$/m,
      due_date: /^Due Date:\s*([\d./-]+)$/m,
      currency: /^Currency:\s*([A-Za-z]{3})$/m,
      subtotal: /^Subtotal:\s*([\d.,\s]+)$/m,
      tax_total: /^Tax:\s*([\d.,\s]+)$/m,
      grand_total: /^Total:\s*([\d.,\s]+)$/m,
    }

    return {
      fields: input.fields.map((field) => {
        const pattern = patterns[field.name]
        if (!pattern) return { name: field.name, value: null, evidence: null }

        for (const page of input.pagesText) {
          const match = pattern.exec(page.text)
          if (match) {
            return {
              name: field.name,
              value: match[1]!.trim(),
              // Evidence — вся строка «Метка: значение»: она уникальнее голого
              // значения и совпадает с OCR-блоком строки целиком.
              evidence: { text: match[0].trim(), page: page.page },
            }
          }
        }
        return { name: field.name, value: null, evidence: null }
      }),
    }
  }
}
