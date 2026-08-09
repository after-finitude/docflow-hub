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
  warnings: [{ ruleId: 'due_after_invoice', fieldName: 'due_date', message: 'Срок раньше даты' }],
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
      normalizedValue: [{ description: 'Услуга', quantity: 1, unit_price: 1200, amount: 1200 }],
    }),
  ],
}

describe('buildCanonicalDocument', () => {
  it('переносит нормализованные значения и версию схемы', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.equal(canonical.formatVersion, CANONICAL_FORMAT_VERSION)
    assert.equal(canonical.schemaVersion, 3)
    assert.equal(canonical.fields.supplier_name!.value, 'Acme GmbH')
    assert.equal(canonical.fields.grand_total!.value, 1440)
  })

  it('сохраняет правки оператора признаком edited', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.equal(canonical.fields.grand_total!.edited, true)
    assert.equal(canonical.fields.supplier_name!.edited, false)
  })

  it('выносит позиции отдельным блоком, а не полем', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.equal(canonical.lineItems?.length, 1)
    assert.equal(canonical.fields.line_items, undefined)
  })

  it('переносит источник только для найденных', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.deepEqual(canonical.fields.supplier_name!.source, {
      page: 1,
      bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
    })
    assert.equal(canonical.fields.grand_total!.source, null)
  })

  it('отсутствующее поле остаётся null, а не пропадает', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.ok('due_date' in canonical.fields)
    assert.equal(canonical.fields.due_date!.value, null)
  })

  it('не выдумывает время: generatedAt берётся из входа', () => {
    const canonical = buildCanonicalDocument(INPUT)
    assert.equal(canonical.generatedAt, '2026-07-16T09:00:05.000Z')
  })

  it('документ без позиций получает lineItems = null', () => {
    const canonical = buildCanonicalDocument({
      ...INPUT,
      fields: [field({ name: 'line_items', valueType: 'array' })],
    })
    assert.equal(canonical.lineItems, null)
  })
})

describe('маппинг на поля назначения', () => {
  const mapping: ExportMapping = [
    { column: 'Документ', source: 'meta:documentId' },
    { column: 'Файл', source: 'meta:originalFilename' },
    { column: 'Поставщик', source: 'field:supplier_name' },
    { column: 'Итого', source: 'field:grand_total' },
    { column: 'Срок', source: 'field:due_date' },
    { column: 'Позиций', source: 'meta:lineItemCount' },
    { column: 'Неизвестно', source: 'field:no_such_field' },
  ]

  it('строит строку в порядке маппинга', () => {
    const row = toRow(buildCanonicalDocument(INPUT), mapping)
    assert.deepEqual(row, ['doc-1', 'invoice.pdf', 'Acme GmbH', 1440, null, 1, null])
  })

  it('заголовок соответствует колонкам', () => {
    assert.deepEqual(toHeader(mapping).slice(0, 3), ['Документ', 'Файл', 'Поставщик'])
  })

  it('числа остаются числами, а не строками', () => {
    const row = toRow(buildCanonicalDocument(INPUT), mapping)
    assert.equal(typeof row[3], 'number')
  })
})
