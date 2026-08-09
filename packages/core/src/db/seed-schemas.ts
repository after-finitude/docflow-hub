import type { ClassifiableDocumentType, FieldSpec, SchemaThresholds } from '@docflow/shared'

/**
 * Схемы четырёх типов обязательного объёма. Invoice — по ТЗ §13 дословно;
 * остальные — разумный минимум в пределах 15 полей на тип (ТЗ §4).
 */

export const DEFAULT_THRESHOLDS: SchemaThresholds = {
  autoClassify: 0.7,
  criticalFieldConfidence: 0.8,
  fieldConfidence: 0.6,
}

export const SEED_SCHEMAS: Record<ClassifiableDocumentType, FieldSpec[]> = {
  invoice: [
    { name: 'supplier_name', label: 'Поставщик', type: 'string', required: true, critical: true },
    {
      name: 'invoice_number',
      label: 'Номер инвойса',
      type: 'string',
      required: true,
      critical: true,
    },
    { name: 'invoice_date', label: 'Дата инвойса', type: 'date', required: true, critical: true },
    { name: 'due_date', label: 'Срок оплаты', type: 'date', required: false, critical: false },
    {
      name: 'currency',
      label: 'Валюта',
      type: 'enum',
      required: true,
      critical: true,
      enumValues: ['EUR', 'USD', 'GBP'],
    },
    { name: 'subtotal', label: 'Сумма без налога', type: 'number', required: true, critical: true },
    { name: 'tax_total', label: 'Налог', type: 'number', required: false, critical: false },
    { name: 'grand_total', label: 'Итого', type: 'number', required: true, critical: true },
    {
      name: 'line_items',
      label: 'Позиции',
      type: 'array',
      required: false,
      critical: false,
      hint: 'Плоская таблица позиций: description, quantity, unit_price, amount',
    },
  ],
  bank_statement: [
    { name: 'bank_name', label: 'Банк', type: 'string', required: true, critical: true },
    {
      name: 'account_number',
      label: 'Номер счёта',
      type: 'string',
      required: true,
      critical: true,
    },
    { name: 'period_start', label: 'Начало периода', type: 'date', required: true, critical: true },
    { name: 'period_end', label: 'Конец периода', type: 'date', required: true, critical: true },
    {
      name: 'opening_balance',
      label: 'Входящий остаток',
      type: 'number',
      required: true,
      critical: true,
    },
    {
      name: 'closing_balance',
      label: 'Исходящий остаток',
      type: 'number',
      required: true,
      critical: true,
    },
    {
      name: 'currency',
      label: 'Валюта',
      type: 'enum',
      required: true,
      critical: false,
      enumValues: ['EUR', 'USD', 'GBP', 'RUB'],
    },
  ],
  tax_letter: [
    { name: 'authority_name', label: 'Орган', type: 'string', required: true, critical: true },
    {
      name: 'letter_number',
      label: 'Номер письма',
      type: 'string',
      required: true,
      critical: true,
    },
    { name: 'letter_date', label: 'Дата письма', type: 'date', required: true, critical: true },
    {
      name: 'taxpayer_name',
      label: 'Налогоплательщик',
      type: 'string',
      required: true,
      critical: true,
    },
    { name: 'taxpayer_id', label: 'ИНН', type: 'string', required: false, critical: false },
    { name: 'subject', label: 'Тема', type: 'string', required: true, critical: false },
    {
      name: 'amount_due',
      label: 'Сумма к уплате',
      type: 'number',
      required: false,
      critical: false,
    },
    { name: 'due_date', label: 'Срок', type: 'date', required: false, critical: false },
  ],
  contract: [
    {
      name: 'contract_number',
      label: 'Номер договора',
      type: 'string',
      required: true,
      critical: true,
    },
    { name: 'contract_date', label: 'Дата договора', type: 'date', required: true, critical: true },
    { name: 'party_a', label: 'Сторона 1', type: 'string', required: true, critical: true },
    { name: 'party_b', label: 'Сторона 2', type: 'string', required: true, critical: true },
    { name: 'subject', label: 'Предмет', type: 'string', required: true, critical: false },
    {
      name: 'contract_value',
      label: 'Сумма договора',
      type: 'number',
      required: false,
      critical: false,
    },
    {
      name: 'currency',
      label: 'Валюта',
      type: 'enum',
      required: false,
      critical: false,
      enumValues: ['EUR', 'USD', 'GBP', 'RUB'],
    },
    {
      name: 'start_date',
      label: 'Начало действия',
      type: 'date',
      required: false,
      critical: false,
    },
    {
      name: 'end_date',
      label: 'Окончание действия',
      type: 'date',
      required: false,
      critical: false,
    },
  ],
}
