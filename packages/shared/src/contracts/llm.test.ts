import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractionResponseSchemaFor } from './llm'
import type { FieldSpec } from './schema'
import { buildExtractedField } from '../pipeline/field-builder'

const totalSpec: FieldSpec = {
  name: 'total',
  label: 'Total',
  type: 'number',
  required: true,
  critical: true,
}
const specs: FieldSpec[] = [
  totalSpec,
  { name: 'line_items', label: 'Items', type: 'array', required: false, critical: false },
]
const schema = extractionResponseSchemaFor(specs)
const item = { description: 'Service', quantity: 2, unit_price: 600, amount: 1200 }
const fields = [
  { name: 'total', value: '1 200,00', evidence: null },
  { name: 'line_items', value: [item], evidence: null },
]

describe('schema-specific extraction contract', () => {
  it('accepts flat items and keeps scalar text verbatim until the shared builder', () => {
    const response = schema.parse({ fields })
    assert.deepEqual(response.fields, fields)
    const total = buildExtractedField(totalSpec, response.fields[0], [])
    assert.equal(total.rawValue, '1 200,00')
    assert.equal(total.normalizedValue, 1200)
  })

  it('accepts explicit absence, empty arrays, and missing numeric cells', () => {
    for (const value of [null, [], [{ ...item, quantity: null, amount: null }]]) {
      assert.ok(schema.safeParse({ fields: [fields[0], { ...fields[1], value }] }).success)
    }
  })

  it('rejects omitted, duplicate, and unknown names', () => {
    for (const invalid of [
      [],
      [fields[0]],
      [...fields, fields[0]],
      [fields[0], { ...fields[1], name: 'unexpected' }],
    ]) {
      assert.equal(schema.safeParse({ fields: invalid }).success, false)
    }
  })

  it('rejects scalar/array mismatches and malformed or nested items', () => {
    for (const value of [
      '[]',
      10,
      true,
      {},
      [{ description: 'Incomplete' }],
      [{ ...item, quantity: '2' }],
      [{ ...item, amount: {} }],
      [{ ...item, nested: { amount: 1200 } }],
    ]) {
      assert.equal(
        schema.safeParse({ fields: [fields[0], { ...fields[1], value }] }).success,
        false,
      )
    }
    for (const value of [[item], 1200, true, {}]) {
      assert.equal(
        schema.safeParse({ fields: [{ ...fields[0], value }, fields[1]] }).success,
        false,
      )
    }
  })

  it('keeps every scalar type verbatim, leaving semantic validation to normalization', () => {
    for (const type of ['string', 'number', 'currency', 'date', 'boolean', 'enum'] as const) {
      const scalar = extractionResponseSchemaFor([{ ...totalSpec, type }])
      assert.ok(scalar.safeParse({ fields: [{ ...fields[0], value: 'as printed' }] }).success)
      assert.equal(scalar.safeParse({ fields: [{ ...fields[0], value: 1 }] }).success, false)
    }
  })

  it('rejects invalid evidence and evidence attached to a missing value', () => {
    for (const evidence of [
      { text: 'Total', page: 0 },
      { text: '', page: 1 },
    ]) {
      assert.equal(
        schema.safeParse({ fields: [{ ...fields[0], evidence }, fields[1]] }).success,
        false,
      )
    }
    assert.equal(
      schema.safeParse({
        fields: [{ ...fields[0], value: null, evidence: { text: 'Total', page: 1 } }, fields[1]],
      }).success,
      false,
    )
  })
})
