import type { ClassifiableDocumentType, ExportMapping } from '@docflow/shared'

/**
 * Маппинг внутренних полей на поля назначения (ТЗ 6.8). Задаётся конфигурацией;
 * порядок колонок значим для табличных адаптеров.
 *
 * Файловый адаптер маппинг не использует: он выгружает канонический JSON как
 * есть — это и есть внутреннее представление.
 */
export const EXPORT_MAPPINGS: Record<ClassifiableDocumentType, ExportMapping> = {
  invoice: [
    { column: 'Документ', source: 'meta:documentId' },
    { column: 'Файл', source: 'meta:originalFilename' },
    { column: 'Поставщик', source: 'field:supplier_name' },
    { column: 'Номер', source: 'field:invoice_number' },
    { column: 'Дата', source: 'field:invoice_date' },
    { column: 'Срок оплаты', source: 'field:due_date' },
    { column: 'Валюта', source: 'field:currency' },
    { column: 'Без налога', source: 'field:subtotal' },
    { column: 'Налог', source: 'field:tax_total' },
    { column: 'Итого', source: 'field:grand_total' },
    { column: 'Позиций', source: 'meta:lineItemCount' },
    { column: 'Подтверждён', source: 'meta:approvedAt' },
  ],
  bank_statement: [
    { column: 'Документ', source: 'meta:documentId' },
    { column: 'Файл', source: 'meta:originalFilename' },
    { column: 'Банк', source: 'field:bank_name' },
    { column: 'Счёт', source: 'field:account_number' },
    { column: 'Период с', source: 'field:period_start' },
    { column: 'Период по', source: 'field:period_end' },
    { column: 'Входящий остаток', source: 'field:opening_balance' },
    { column: 'Исходящий остаток', source: 'field:closing_balance' },
    { column: 'Валюта', source: 'field:currency' },
    { column: 'Подтверждён', source: 'meta:approvedAt' },
  ],
  tax_letter: [
    { column: 'Документ', source: 'meta:documentId' },
    { column: 'Файл', source: 'meta:originalFilename' },
    { column: 'Орган', source: 'field:authority_name' },
    { column: 'Номер письма', source: 'field:letter_number' },
    { column: 'Дата письма', source: 'field:letter_date' },
    { column: 'Налогоплательщик', source: 'field:taxpayer_name' },
    { column: 'ИНН', source: 'field:taxpayer_id' },
    { column: 'Тема', source: 'field:subject' },
    { column: 'Сумма к уплате', source: 'field:amount_due' },
    { column: 'Срок', source: 'field:due_date' },
    { column: 'Подтверждён', source: 'meta:approvedAt' },
  ],
  contract: [
    { column: 'Документ', source: 'meta:documentId' },
    { column: 'Файл', source: 'meta:originalFilename' },
    { column: 'Номер договора', source: 'field:contract_number' },
    { column: 'Дата договора', source: 'field:contract_date' },
    { column: 'Сторона 1', source: 'field:party_a' },
    { column: 'Сторона 2', source: 'field:party_b' },
    { column: 'Предмет', source: 'field:subject' },
    { column: 'Сумма', source: 'field:contract_value' },
    { column: 'Валюта', source: 'field:currency' },
    { column: 'Начало', source: 'field:start_date' },
    { column: 'Окончание', source: 'field:end_date' },
    { column: 'Подтверждён', source: 'meta:approvedAt' },
  ],
}
