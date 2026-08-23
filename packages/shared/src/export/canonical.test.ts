import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CANONICAL_FORMAT_VERSION,
  buildCanonicalDocument,
  toHeader,
  toRow,
  type CanonicalInput,
  type CanonicalInputField,
  type ExportMapping,
} from './canonical'

function field(overrides: Partial<CanonicalInputField> & { name: string }): CanonicalInputField {
  return {
    valueType: 'string',
    rawValue: null,
    normalizedValue: null,
    confidence: null,
    isEdited: false,
    sourcePage: null,
    sourceBbox: null,
    sourceFound: false,
    ...overrides,
  }
}

const INPUT: CanonicalInput = {
  documentId: 'doc-1',
  documentType: 'invoice',
  schemaVersion: 3,
  sourceType: 'upload',
  originalFilename: 'invoice.pdf',
  checksum: 'abc123',
  receivedAt: '2026-07-15T10:00:00.000Z',
  approvedAt: '2026-07-16T09:00:00.000Z',
  generatedAt: '2026-07-16T09:00:05.000Z',
  warnings: [
    { ruleId: 'due_after_invoice', fieldName: 'due_date', message: 'Due date is earlier' },
  ],
  fields: [
    field({
      name: 'supplier_name',
      normalizedValue: 'Acme GmbH',
      rawValue: 'Supplier: Acme GmbH',
      confidence: 0.92,
      sourceFound: true,
      sourcePage: 1,
      sourceBbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
    }),
    field({
      name: 'grand_total',
      valueType: 'number',
      normalizedValue: 1440,
      rawValue: '1440.00',
      confidence: 1,
      isEdited: true,
    }),
    field({ name: 'due_date', valueType: 'date' }),
    field({
      name: 'line_items',
      valueType: 'array',
      normalizedValue: [{ description: 'Service', quantity: 1, unit_price: 1200, amount: 1200 }],
    }),
  ],
}

describe('buildCanonicalDocument', () => {
  it('carries over normalized values and schema version', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.equal(canonical.formatVersion, CANONICAL_FORMAT_VERSION)
    assert.equal(canonical.schemaVersion, 3)
    assert.equal(canonical.fields.supplier_name!.value, 'Acme GmbH')
    assert.equal(canonical.fields.grand_total!.value, 1440)
  })

  it('marks operator edits with edited', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.equal(canonical.fields.grand_total!.edited, true)
    assert.equal(canonical.fields.supplier_name!.edited, false)
  })

  it('moves line items into a separate block', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.equal(canonical.lineItems?.length, 1)
    assert.equal(canonical.fields.line_items, undefined)
  })

  it('includes sources only when found', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.deepEqual(canonical.fields.supplier_name!.source, {
      page: 1,
      bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
    })
    assert.equal(canonical.fields.grand_total!.source, null)
  })

  it('retains a missing field as null', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.ok('due_date' in canonical.fields)
    assert.equal(canonical.fields.due_date!.value, null)
  })

  it('uses generatedAt from the input', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.equal(canonical.generatedAt, '2026-07-16T09:00:05.000Z')
  })

  it('sets lineItems to null when absent', () => {
    const canonical = buildCanonicalDocument({
      ...INPUT,
      fields: [field({ name: 'line_items', valueType: 'array' })],
    })
    assert.equal(canonical.lineItems, null)
  })
})

describe('destination field mapping', () => {
  const mapping: ExportMapping = [
    { column: 'Document', source: 'meta:documentId' },
    { column: 'File', source: 'meta:originalFilename' },
    { column: 'Supplier', source: 'field:supplier_name' },
    { column: 'Total', source: 'field:grand_total' },
    { column: 'Due date', source: 'field:due_date' },
    { column: 'Line items', source: 'meta:lineItemCount' },
    { column: 'Unknown', source: 'field:no_such_field' },
  ]

  it('builds a row in mapping order', () => {
    const row = toRow(buildCanonicalDocument(INPUT), mapping)
    assert.deepEqual(row, ['doc-1', 'invoice.pdf', 'Acme GmbH', 1440, null, 1, null])
  })

  it('builds a header from columns', () => {
    assert.deepEqual(toHeader(mapping).slice(0, 3), ['Document', 'File', 'Supplier'])
  })

  it('keeps numbers as numbers', () => {
    const row = toRow(buildCanonicalDocument(INPUT), mapping)
    assert.equal(typeof row[3], 'number')
  })
})
