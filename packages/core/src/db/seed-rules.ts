import type { ClassifiableDocumentType, ValidationRule } from '@docflow/shared'

/**
 * Validation rules by type (spec 6.6). Invoice follows spec §13. The only
 * cross-document rule, invoice_number uniqueness, runs in ValidationRunnerService.
 */
export const SEED_RULES: Record<ClassifiableDocumentType, ValidationRule[]> = {
  invoice: [
    {
      id: 'invoice_date_not_far_future',
      type: 'date_offset',
      severity: 'warning',
      field: 'invoice_date',
      maxDaysFromToday: 7,
    },
    {
      id: 'due_date_after_invoice_date',
      type: 'date_order',
      severity: 'warning',
      field: 'due_date',
      notEarlierThan: 'invoice_date',
    },
    {
      id: 'currency_allowed',
      type: 'enum',
      severity: 'blocking',
      field: 'currency',
      values: ['EUR', 'USD', 'GBP'],
    },
    {
      id: 'subtotal_non_negative',
      type: 'number_range',
      severity: 'blocking',
      field: 'subtotal',
      min: 0,
    },
    {
      id: 'tax_total_non_negative',
      type: 'number_range',
      severity: 'blocking',
      field: 'tax_total',
      min: 0,
    },
    {
      // Spec §13: subtotal + tax_total ≈ grand_total, tolerance 0.02, blocking.
      id: 'invoice_totals_match',
      type: 'sum',
      severity: 'blocking',
      target: 'grand_total',
      operands: ['subtotal', 'tax_total'],
      tolerance: 0.02,
    },
    { id: 'line_items_shape', type: 'array_or_absent', severity: 'warning', field: 'line_items' },
  ],
  bank_statement: [
    {
      id: 'statement_period_order',
      type: 'date_order',
      severity: 'blocking',
      field: 'period_end',
      notEarlierThan: 'period_start',
    },
    {
      id: 'statement_balances_match',
      type: 'statement_balance',
      severity: 'blocking',
      field: 'transactions',
      opening: 'opening_balance',
      closing: 'closing_balance',
      creditTotal: 'total_credit',
      debitTotal: 'total_debit',
      tolerance: 0.02,
    },
  ],
  tax_letter: [
    {
      id: 'tax_letter_date_not_future',
      type: 'date_offset',
      severity: 'warning',
      field: 'letter_date',
      maxDaysFromToday: 0,
    },
    {
      id: 'tax_amount_non_negative',
      type: 'number_range',
      severity: 'warning',
      field: 'amount_due',
      min: 0,
    },
  ],
  contract: [
    {
      id: 'contract_period_order',
      type: 'date_order',
      severity: 'warning',
      field: 'end_date',
      notEarlierThan: 'start_date',
    },
    {
      id: 'contract_value_non_negative',
      type: 'number_range',
      severity: 'warning',
      field: 'contract_value',
      min: 0,
    },
  ],
}
