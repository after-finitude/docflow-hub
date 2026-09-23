import assert from 'node:assert/strict'
import { it } from 'node:test'
import { extractionResponseSchemaFor } from '../contracts/llm'
import {
  tableValueSchemaFor,
  updateFieldRequestSchema,
  type BankTransaction,
} from '../contracts/review'
import { buildCanonicalDocument } from '../export/canonical'
import { normalizeAmount } from '../normalize/values'
import { validateDocument, type ValidationField } from './engine'
import type { ValidationRule } from './rules'

it('preserves statement rows and blocks incomplete or unreconciled statements', () => {
  const rows: BankTransaction[] = [
    {
      date: '01/09/2026',
      reference: '00012',
      payment_type: 'BACS',
      description: 'Deposit',
      credit: 100,
      debit: null,
      balance: 150,
    },
    {
      date: '02/09/2026',
      reference: null,
      payment_type: null,
      description: 'Payment',
      credit: null,
      debit: 200,
      balance: -50,
    },
  ]
  const table: ValidationField = {
    name: 'transactions',
    label: 'Transactions',
    valueType: 'array',
    rawValue: JSON.stringify(rows),
    normalizedValue: rows,
    isRequired: true,
    isCritical: true,
  }
  const money = (name: string, value: number): ValidationField => ({
    name,
    label: name,
    valueType: 'number',
    rawValue: String(value),
    normalizedValue: value,
    isRequired: false,
    isCritical: false,
  })
  const rule: ValidationRule = {
    id: 'statement_balances_match',
    type: 'statement_balance',
    severity: 'blocking',
    field: 'transactions',
    opening: 'opening_balance',
    closing: 'closing_balance',
    creditTotal: 'total_credit',
    debitTotal: 'total_debit',
    tolerance: 0.02,
  }
  const fields = [
    table,
    money('opening_balance', 50),
    money('closing_balance', -50),
    money('total_credit', 100),
    money('total_debit', 200),
  ]
  const validate = (value: ValidationField[]) =>
    validateDocument(value, [rule], { today: '2026-09-07' })
  assert.deepEqual(validate(fields), [])
  assert.deepEqual(
    validate([{ ...table, normalizedValue: rows.toReversed() }, ...fields.slice(1)]),
    [],
  )
  assert.equal(
    validate([table, money('opening_balance', 50), money('closing_balance', 50)])[0]?.severity,
    'blocking',
  )
  assert.equal(
    validate([table, ...fields.slice(1, 3), money('total_credit', 101)])[0]?.severity,
    'blocking',
  )
  assert.equal(
    validate([{ ...table, normalizedValue: [{ ...rows[0], debit: 20 }] }])[0]?.severity,
    'blocking',
  )
  assert.equal(
    validate([{ ...table, normalizedValue: [{ ...rows[0], date: null }] }])[0]?.severity,
    'blocking',
  )
  assert.equal(
    validate([{ ...table, rawValue: null, normalizedValue: null }])[0]?.ruleId,
    'required:transactions',
  )
  assert.deepEqual(
    validate([
      { ...table, normalizedValue: [] },
      money('opening_balance', 50),
      money('closing_balance', 50),
    ]),
    [],
  )
  for (const date of ['31/02/2026', 'mm/dd/yyyy', '2026-02-29', '15 July 2026 garbage', '']) {
    assert.equal(
      validate([{ ...table, normalizedValue: [{ ...rows[0], date }] }])[0]?.severity,
      'blocking',
      `Reject invalid date: ${date}`,
    )
  }
  for (const date of ['2024-02-29', '29/02/2024', '09/30/2026', '15 July 2026', 'July 15, 2026']) {
    assert.deepEqual(validate([{ ...table, normalizedValue: [{ ...rows[0], date }] }]), [])
  }

  const responseSchema = extractionResponseSchemaFor([
    { name: 'transactions', label: 'Transactions', type: 'array', required: true, critical: true },
  ])
  assert.deepEqual(
    responseSchema.parse({ fields: [{ name: 'transactions', value: rows, evidence: null }] })
      .fields[0]?.value,
    rows,
  )
  assert.equal(
    responseSchema.safeParse({
      fields: [
        {
          name: 'transactions',
          value: [{ description: 'Wrong shape', quantity: 1, unit_price: 1, amount: 1 }],
          evidence: null,
        },
      ],
    }).success,
    false,
  )
  assert.equal(tableValueSchemaFor('line_items').safeParse(rows).success, false)
  assert.deepEqual(updateFieldRequestSchema.parse({ value: rows }).value, rows)
  assert.equal(
    updateFieldRequestSchema.safeParse({ value: [{ ...rows[0], credit: -1 }] }).success,
    false,
  )

  const exported = buildCanonicalDocument({
    documentId: 'statement',
    documentType: 'bank_statement',
    schemaVersion: 2,
    sourceType: 'upload',
    originalFilename: 'statement.pdf',
    checksum: 'example',
    receivedAt: '2026-09-07T00:00:00Z',
    approvedAt: null,
    generatedAt: '2026-09-07T00:00:00Z',
    warnings: [],
    fields: [
      {
        ...table,
        confidence: null,
        isEdited: true,
        sourceFound: false,
        sourcePage: null,
        sourceBbox: null,
      },
    ],
  })
  assert.deepEqual(exported.fields.transactions?.value, rows)
  assert.equal(exported.fields.transactions?.edited, true)
  assert.equal(exported.lineItems, null)
  for (const text of [
    '(1,200.00)',
    '1 200,00 DR',
    '1200DR',
    '1200 USD DR',
    '1200.00-',
    '−1200.00',
  ]) {
    assert.equal(normalizeAmount(text), -1200)
  }
  assert.equal(normalizeAmount('1,200.00 CR'), 1200)
  assert.equal(normalizeAmount('1,200.00 IDR'), 1200)
  assert.equal(normalizeAmount('1200IDR'), 1200)
  assert.equal(normalizeAmount('IDR 1200'), 1200)
})
