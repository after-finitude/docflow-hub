import type { ClassifiableDocumentType, FieldSpec, SchemaThresholds } from '@docflow/shared'

/**
 * Schemas for the four required document types. Invoice follows spec §13;
 * the others use a practical minimum within 15 fields per type (spec §4).
 */

export const DEFAULT_THRESHOLDS: SchemaThresholds = {
  autoClassify: 0.7,
  criticalFieldConfidence: 0.8,
  fieldConfidence: 0.6,
}

export const SEED_SCHEMAS: Record<ClassifiableDocumentType, FieldSpec[]> = {
  invoice: [
    { name: 'supplier_name', label: 'Supplier', type: 'string', required: true, critical: true },
    {
      name: 'invoice_number',
      label: 'Invoice number',
      type: 'string',
      required: true,
      critical: true,
    },
    { name: 'invoice_date', label: 'Invoice date', type: 'date', required: true, critical: true },
    { name: 'due_date', label: 'Due date', type: 'date', required: false, critical: false },
    {
      name: 'currency',
      label: 'Currency',
      type: 'enum',
      required: true,
      critical: true,
      enumValues: ['EUR', 'USD', 'GBP'],
    },
    { name: 'subtotal', label: 'Subtotal', type: 'number', required: true, critical: true },
    { name: 'tax_total', label: 'Tax total', type: 'number', required: false, critical: false },
    { name: 'grand_total', label: 'Grand total', type: 'number', required: true, critical: true },
    {
      name: 'line_items',
      label: 'Line items',
      type: 'array',
      required: false,
      critical: false,
      hint: 'Flat line-items table: description, quantity, unit_price, amount',
    },
  ],
  bank_statement: [
    { name: 'bank_name', label: 'Bank', type: 'string', required: true, critical: true },
    {
      name: 'account_number',
      label: 'Account number',
      type: 'string',
      required: true,
      critical: true,
    },
    { name: 'period_start', label: 'Period start', type: 'date', required: true, critical: true },
    { name: 'period_end', label: 'Period end', type: 'date', required: true, critical: true },
    {
      name: 'opening_balance',
      label: 'Opening balance',
      type: 'number',
      required: true,
      critical: true,
    },
    {
      name: 'closing_balance',
      label: 'Closing balance',
      type: 'number',
      required: true,
      critical: true,
    },
    {
      name: 'currency',
      label: 'Currency',
      type: 'enum',
      required: true,
      critical: false,
      enumValues: ['EUR', 'USD', 'GBP', 'RUB'],
    },
  ],
  tax_letter: [
    { name: 'authority_name', label: 'Authority', type: 'string', required: true, critical: true },
    {
      name: 'letter_number',
      label: 'Letter number',
      type: 'string',
      required: true,
      critical: true,
    },
    { name: 'letter_date', label: 'Letter date', type: 'date', required: true, critical: true },
    {
      name: 'taxpayer_name',
      label: 'Taxpayer',
      type: 'string',
      required: true,
      critical: true,
    },
    { name: 'taxpayer_id', label: 'Taxpayer ID', type: 'string', required: false, critical: false },
    { name: 'subject', label: 'Subject', type: 'string', required: true, critical: false },
    {
      name: 'amount_due',
      label: 'Amount due',
      type: 'number',
      required: false,
      critical: false,
    },
    { name: 'due_date', label: 'Due date', type: 'date', required: false, critical: false },
  ],
  contract: [
    {
      name: 'contract_number',
      label: 'Contract number',
      type: 'string',
      required: true,
      critical: true,
    },
    { name: 'contract_date', label: 'Contract date', type: 'date', required: true, critical: true },
    { name: 'party_a', label: 'Party A', type: 'string', required: true, critical: true },
    { name: 'party_b', label: 'Party B', type: 'string', required: true, critical: true },
    { name: 'subject', label: 'Subject', type: 'string', required: true, critical: false },
    {
      name: 'contract_value',
      label: 'Contract value',
      type: 'number',
      required: false,
      critical: false,
    },
    {
      name: 'currency',
      label: 'Currency',
      type: 'enum',
      required: false,
      critical: false,
      enumValues: ['EUR', 'USD', 'GBP', 'RUB'],
    },
    {
      name: 'start_date',
      label: 'Start date',
      type: 'date',
      required: false,
      critical: false,
    },
    {
      name: 'end_date',
      label: 'End date',
      type: 'date',
      required: false,
      critical: false,
    },
  ],
}
