import type { ClassifiableDocumentType, ExportMapping } from '@docflow/shared'

/**
 * Map internal fields to destination columns (spec 6.8). Configuration defines
 * it, and column order matters for tabular adapters.
 *
 * The file adapter does not use a mapping; it exports canonical JSON unchanged.
 */
export const EXPORT_MAPPINGS: Record<ClassifiableDocumentType, ExportMapping> = {
  invoice: [
    { column: 'Document', source: 'meta:documentId' },
    { column: 'File', source: 'meta:originalFilename' },
    { column: 'Supplier', source: 'field:supplier_name' },
    { column: 'Number', source: 'field:invoice_number' },
    { column: 'Date', source: 'field:invoice_date' },
    { column: 'Due date', source: 'field:due_date' },
    { column: 'Currency', source: 'field:currency' },
    { column: 'Subtotal', source: 'field:subtotal' },
    { column: 'Tax', source: 'field:tax_total' },
    { column: 'Total', source: 'field:grand_total' },
    { column: 'Line items', source: 'meta:lineItemCount' },
    { column: 'Approved at', source: 'meta:approvedAt' },
  ],
  bank_statement: [
    { column: 'Document', source: 'meta:documentId' },
    { column: 'File', source: 'meta:originalFilename' },
    { column: 'Bank', source: 'field:bank_name' },
    { column: 'Account', source: 'field:account_number' },
    { column: 'Period start', source: 'field:period_start' },
    { column: 'Period end', source: 'field:period_end' },
    { column: 'Opening balance', source: 'field:opening_balance' },
    { column: 'Closing balance', source: 'field:closing_balance' },
    { column: 'Currency', source: 'field:currency' },
    { column: 'Approved at', source: 'meta:approvedAt' },
  ],
  tax_letter: [
    { column: 'Document', source: 'meta:documentId' },
    { column: 'File', source: 'meta:originalFilename' },
    { column: 'Authority', source: 'field:authority_name' },
    { column: 'Letter number', source: 'field:letter_number' },
    { column: 'Letter date', source: 'field:letter_date' },
    { column: 'Taxpayer', source: 'field:taxpayer_name' },
    { column: 'Taxpayer ID', source: 'field:taxpayer_id' },
    { column: 'Subject', source: 'field:subject' },
    { column: 'Amount due', source: 'field:amount_due' },
    { column: 'Due date', source: 'field:due_date' },
    { column: 'Approved at', source: 'meta:approvedAt' },
  ],
  contract: [
    { column: 'Document', source: 'meta:documentId' },
    { column: 'File', source: 'meta:originalFilename' },
    { column: 'Contract number', source: 'field:contract_number' },
    { column: 'Contract date', source: 'field:contract_date' },
    { column: 'Party A', source: 'field:party_a' },
    { column: 'Party B', source: 'field:party_b' },
    { column: 'Subject', source: 'field:subject' },
    { column: 'Value', source: 'field:contract_value' },
    { column: 'Currency', source: 'field:currency' },
    { column: 'Start date', source: 'field:start_date' },
    { column: 'End date', source: 'field:end_date' },
    { column: 'Approved at', source: 'meta:approvedAt' },
  ],
}
