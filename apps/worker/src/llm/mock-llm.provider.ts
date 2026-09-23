import {
  extractionResponseSchemaFor,
  type ClassificationResponse,
  type ExtractionResponse,
  type LineItem,
  type BankTransaction,
} from '@docflow/shared'
import { Injectable } from '@nestjs/common'
import type { ClassifyInput, ExtractInput, LlmProvider } from './llm-provider'

/**
 * Deterministic LLM without external calls.
 *
 * Classification uses heading patterns; extraction uses the “Label: value”
 * format in demo documents and fixtures. Evidence is always a verbatim page
 * line so the matcher can locate it normally.
 *
 * Deliberate limitation: the mock knows the demo dataset format, so it measures
 * pipeline behavior rather than model quality. Measure real extraction quality
 * with `npm run eval` and LLM_PROVIDER=openai_compatible.
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

    // Match headings rather than individual words: “tax” appears in every
    // invoice and a naive rule would classify invoices as unknown.
    const rules: Array<{ type: ClassificationResponse['document_type']; pattern: RegExp }> = [
      {
        type: 'invoice',
        pattern: /^\s*(invoice|\u0441\u0447\u0451\u0442|\u0441\u0447\u0435\u0442)\b/m,
      },
      {
        type: 'bank_statement',
        pattern:
          /^\s*(bank statement|\u0432\u044b\u043f\u0438\u0441\u043a\u0430)\b|opening balance|\u0432\u0445\u043e\u0434\u044f\u0449\u0438\u0439 \u043e\u0441\u0442\u0430\u0442\u043e\u043a/m,
      },
      {
        type: 'tax_letter',
        pattern:
          /^\s*(tax notice|\u043d\u0430\u043b\u043e\u0433\u043e\u0432\u043e\u0435 \u0443\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u0435|\u0443\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u0435)\b|tax office|\u043d\u0430\u043b\u043e\u0433\u043e\u0432\u0430\u044f \u0438\u043d\u0441\u043f\u0435\u043a\u0446\u0438\u044f/m,
      },
      {
        type: 'contract',
        pattern:
          /^\s*(contract|agreement|\u0434\u043e\u0433\u043e\u0432\u043e\u0440|\u0441\u043e\u0433\u043b\u0430\u0448\u0435\u043d\u0438\u0435)\b/m,
      },
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

    // A repeated heading later in the text indicates multiple documents in one
    // file and supports the demo dataset's negative scenario.
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
    const patterns = PATTERNS_BY_TYPE[input.documentType] ?? {}

    return extractionResponseSchemaFor(input.fields).parse({
      fields: input.fields.map((field) => {
        if (input.documentType === 'bank_statement' && field.name === 'transactions') {
          // ponytail: only the synthetic pipe-delimited table; real bank layouts need a real LLM.
          const rows: BankTransaction[] = []
          let evidence: { text: string; page: number } | null = null
          let inTable = false
          let noActivity = false
          for (const page of input.pagesText) {
            for (const text of page.text.split('\n').map((line) => line.trim())) {
              if (text === 'Date | Reference | Type | Description | Credit | Debit | Balance') {
                inTable = true
                continue
              }
              if (text === 'End of transactions') inTable = false
              if (text === 'No transactions in this period') {
                noActivity = true
                evidence ??= { text, page: page.page }
              }
              if (!inTable) continue
              const cells = text.split('|').map((cell) => cell.trim())
              if (cells.length !== 7) continue
              const [date, reference, paymentType, description, credit, debit, balance] = cells
              if (!date && !reference && !paymentType && !credit && !debit && !balance) {
                const previous = rows.at(-1)
                if (previous && description) previous.description += ` ${description}`
                continue
              }
              rows.push({
                date: date || null,
                reference: reference || null,
                payment_type: paymentType || null,
                description: description!,
                credit: credit ? Number(credit) : null,
                debit: debit ? Number(debit) : null,
                balance: balance ? Number(balance) : null,
              })
              evidence ??= { text, page: page.page }
            }
          }
          return { name: field.name, value: rows.length || noActivity ? rows : null, evidence }
        }
        if (input.documentType === 'invoice' && field.name === 'line_items') {
          const items: LineItem[] = []
          let evidence: { text: string; page: number } | null = null
          for (const page of input.pagesText) {
            // ponytail: demo rows only; use the real provider for arbitrary tables.
            for (const match of page.text.matchAll(
              /^([^\r\n]+?)\s+x(\d+(?:\.\d+)?)\s+(\d+\.\d{2})(?:[ \t]+(\d+\.\d{2}))?[ \t]*$/gm,
            )) {
              items.push({
                description: (match[1] ?? '').trim(),
                quantity: Number(match[2]),
                unit_price: Number(match[3]),
                amount: match[4] === undefined ? null : Number(match[4]),
              })
              evidence ??= { text: match[0].trim(), page: page.page }
            }
          }
          return { name: field.name, value: items.length ? items : null, evidence }
        }
        const pattern = patterns[field.name]
        if (!pattern) return { name: field.name, value: null, evidence: null }

        for (const page of input.pagesText) {
          const match = pattern.exec(page.text)
          if (match) {
            return {
              name: field.name,
              value: match[1]!.trim(),
              // Evidence is the full “Label: value” line, which is more unique
              // than the value alone and matches the complete OCR line block.
              evidence: { text: match[0].trim(), page: page.page },
            }
          }
        }
        return { name: field.name, value: null, evidence: null }
      }),
    })
  }
}

/** Demo dataset labels by document type. */
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
    total_credit: /^Total Credit:\s*([\d.,\s-]+)$/m,
    total_debit: /^Total Debit:\s*([\d.,\s-]+)$/m,
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
