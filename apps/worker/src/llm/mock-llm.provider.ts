import type { ClassificationResponse, ExtractionResponse } from '@docflow/shared'
import { Injectable } from '@nestjs/common'
import type { ClassifyInput, ExtractInput, LlmProvider } from './llm-provider'

/**
 * Детерминированный LLM без внешних вызовов.
 *
 * Классификация — по заголовочным паттернам; извлечение — по шаблону
 * «Метка: значение», которым размечены демо-документы (scripts/generate-dataset.mjs)
 * и фикстуры. Evidence всегда дословная строка из текста страницы, поэтому
 * матчер находит её штатно.
 *
 * Осознанное ограничение: mock знает формат демо-набора, поэтому измеряет
 * не качество модели, а работоспособность конвейера. Реальное качество
 * извлечения даёт `npm run eval` с LLM_PROVIDER=openai_compatible.
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
        pattern: /^\s*(bank statement|выписка)\b|opening balance|входящий остаток/m,
      },
      {
        type: 'tax_letter',
        pattern:
          /^\s*(tax notice|налоговое уведомление|уведомление)\b|tax office|налоговая инспекция/m,
      },
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

    // Повторная шапка дальше по тексту — признак нескольких документов
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
    const patterns = PATTERNS_BY_TYPE[input.documentType]
    if (!patterns) {
      // Неизвестный тип: честный Missing по каждому полю — «не выдумывать»
      // (ТЗ §9) относится и к mock-реализации.
      return {
        fields: input.fields.map((field) => ({ name: field.name, value: null, evidence: null })),
      }
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

/** Метки демо-набора по типам документов. */
const PATTERNS_BY_TYPE: Record<string, Record<string, RegExp>> = {
  invoice: {
    supplier_name: /^Supplier:\s*(.+)$/m,
    invoice_number: /^Invoice No:\s*(\S+)$/m,
    invoice_date: /^Date:\s*([\d./-]+)$/m,
    due_date: /^Due Date:\s*([\d./-]+)$/m,
    currency: /^Currency:\s*([A-Za-z]{3})$/m,
    subtotal: /^Subtotal:\s*([\d.,\s]+)$/m,
    tax_total: /^Tax:\s*([\d.,\s]+)$/m,
    grand_total: /^Total:\s*([\d.,\s]+)$/m,
  },
  bank_statement: {
    bank_name: /^Bank:\s*(.+)$/m,
    account_number: /^Account:\s*(\S+)$/m,
    period_start: /^Period From:\s*([\d./-]+)$/m,
    period_end: /^Period To:\s*([\d./-]+)$/m,
    opening_balance: /^Opening Balance:\s*([\d.,\s-]+)$/m,
    closing_balance: /^Closing Balance:\s*([\d.,\s-]+)$/m,
    currency: /^Currency:\s*([A-Za-z]{3})$/m,
  },
  tax_letter: {
    authority_name: /^Authority:\s*(.+)$/m,
    letter_number: /^Letter No:\s*(\S+)$/m,
    letter_date: /^Date:\s*([\d./-]+)$/m,
    taxpayer_name: /^Taxpayer:\s*(.+)$/m,
    taxpayer_id: /^Taxpayer ID:\s*(\S+)$/m,
    subject: /^Subject:\s*(.+)$/m,
    amount_due: /^Amount Due:\s*([\d.,\s]+)$/m,
    due_date: /^Pay By:\s*([\d./-]+)$/m,
  },
  contract: {
    contract_number: /^Contract No:\s*(\S+)$/m,
    contract_date: /^Date:\s*([\d./-]+)$/m,
    party_a: /^Party A:\s*(.+)$/m,
    party_b: /^Party B:\s*(.+)$/m,
    subject: /^Subject:\s*(.+)$/m,
    contract_value: /^Value:\s*([\d.,\s]+)$/m,
    currency: /^Currency:\s*([A-Za-z]{3})$/m,
    start_date: /^Valid From:\s*([\d./-]+)$/m,
    end_date: /^Valid To:\s*([\d./-]+)$/m,
  },
}
