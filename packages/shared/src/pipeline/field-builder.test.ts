import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NO_SOURCE_CONFIDENCE_CAP } from '../constants'
import type { FieldSpec } from '../contracts/schema'
import type { EvidencePage } from '../matching/evidence-matcher'
import { buildExtractedField } from './field-builder'

const SPEC: FieldSpec = {
  name: 'supplier_name',
  label: 'Поставщик',
  type: 'string',
  required: true,
  critical: true,
}

const PAGES: EvidencePage[] = [
  {
    pageNumber: 1,
    blocks: [
      {
        text: 'Supplier: Acme GmbH',
        bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.03 },
        confidence: 0.95,
      },
    ],
  },
]

describe('buildExtractedField', () => {
  it('находит источник и переносит bbox', () => {
    const field = buildExtractedField(
      SPEC,
      { value: 'Acme GmbH', evidence: { text: 'Supplier: Acme GmbH', page: 1 } },
      PAGES,
    )
    assert.equal(field.sourceFound, true)
    assert.equal(field.sourcePage, 1)
    assert.deepEqual(field.sourceBbox, { x: 0.1, y: 0.1, width: 0.4, height: 0.03 })
  })

  it('отсутствующее значение помечается как Missing без догадок', () => {
    const field = buildExtractedField(SPEC, { value: null, evidence: null }, PAGES)
    assert.equal(field.rawValue, null)
    assert.equal(field.normalizedValue, null)
    assert.equal(field.sourceFound, false)
    assert.equal(field.confidence, null)
  })

  it('поле без evidence ограничено потолком уверенности (ТЗ §9)', () => {
    const field = buildExtractedField(SPEC, { value: 'Acme GmbH', evidence: null }, PAGES)
    assert.equal(field.sourceFound, false)
    assert.ok(field.confidence !== null && field.confidence <= NO_SOURCE_CONFIDENCE_CAP)
  })

  it('ненайденный фрагмент тоже оставляет поле без источника', () => {
    const field = buildExtractedField(
      SPEC,
      { value: 'Acme GmbH', evidence: { text: 'такого текста нет', page: 1 } },
      PAGES,
    )
    assert.equal(field.sourceFound, false)
  })

  it('нормализует значение по типу поля', () => {
    const field = buildExtractedField(
      { ...SPEC, name: 'invoice_date', type: 'date' },
      { value: '15.07.2026', evidence: null },
      PAGES,
    )
    assert.equal(field.normalizedValue, '2026-07-15')
  })

  it('сообщает, если значение не приводится к типу', () => {
    const field = buildExtractedField(
      { ...SPEC, name: 'subtotal', type: 'number' },
      { value: 'не число', evidence: null },
      PAGES,
    )
    assert.equal(field.normalizedValue, null)
    assert.match(field.confidenceReason ?? '', /привести значение к типу number/)
  })

  it('сохраняет сигналы уверенности для последующей перевалидации', () => {
    const field = buildExtractedField(
      SPEC,
      { value: 'Acme GmbH', evidence: { text: 'Supplier: Acme GmbH', page: 1 } },
      PAGES,
    )
    assert.equal(field.confidenceSignals?.sourceFound, true)
    assert.equal(field.confidenceSignals?.ocr, 0.95)
  })

  it('массив позиций сохраняется как есть', () => {
    const items = [{ description: 'Услуга', quantity: 1, unit_price: 100, amount: 100 }]
    const field = buildExtractedField(
      { ...SPEC, name: 'line_items', type: 'array', critical: false },
      { value: items, evidence: null },
      PAGES,
    )
    assert.deepEqual(field.normalizedValue, items)
    assert.equal(field.rawValue, JSON.stringify(items))
  })
})
