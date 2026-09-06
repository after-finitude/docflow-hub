import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateDocument, type ValidationField } from './engine'
import type { ValidationRule } from './rules'

const CONTEXT = { today: '2026-07-20' }

function field(overrides: Partial<ValidationField> & { name: string }): ValidationField {
  return {
    label: overrides.name,
    valueType: 'string',
    rawValue: null,
    normalizedValue: null,
    isRequired: false,
    isCritical: false,
    ...overrides,
  }
}

function money(name: string, value: number | null): ValidationField {
  return field({
    name,
    label: name,
    valueType: 'number',
    normalizedValue: value,
    rawValue: value === null ? null : String(value),
  })
}

describe('required fields', () => {
  it('blocks a missing critical required field', () => {
    const issues = validateDocument(
      [field({ name: 'supplier_name', isRequired: true, isCritical: true })],
      [],
      CONTEXT,
    )
    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.severity, 'blocking')
  })

  it('blocks a missing noncritical required field', () => {
    const issues = validateDocument([field({ name: 'subject', isRequired: true })], [], CONTEXT)
    assert.equal(issues[0]!.severity, 'blocking')
  })

  it('does not flag a populated field', () => {
    const issues = validateDocument(
      [
        field({
          name: 'supplier_name',
          isRequired: true,
          isCritical: true,
          normalizedValue: 'Acme',
        }),
      ],
      [],
      CONTEXT,
    )
    assert.equal(issues.length, 0)
  })

  it('treats an empty line-item array as missing', () => {
    const issues = validateDocument(
      [field({ name: 'line_items', valueType: 'array', isRequired: true, normalizedValue: [] })],
      [],
      CONTEXT,
    )
    assert.equal(issues.length, 1)
  })
})

describe('amount arithmetic (spec §13, blocking)', () => {
  const rule: ValidationRule = {
    id: 'invoice_totals',
    type: 'sum',
    severity: 'blocking',
    target: 'grand_total',
    operands: ['subtotal', 'tax_total'],
    tolerance: 0.02,
  }

  it('accepts matching amounts', () => {
    const issues = validateDocument(
      [money('subtotal', 1200), money('tax_total', 240), money('grand_total', 1440)],
      [rule],
      CONTEXT,
    )
    assert.equal(issues.length, 0)
  })

  it('returns a blocking issue with expected and actual values for a mismatch', () => {
    const issues = validateDocument(
      [money('subtotal', 1200), money('tax_total', 240), money('grand_total', 1400)],
      [rule],
      CONTEXT,
    )
    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.severity, 'blocking')
    assert.equal(issues[0]!.expected, '1440.00')
    assert.equal(issues[0]!.actual, '1400.00')
    assert.match(issues[0]!.message, /1200\.00.*240\.00.*1440\.00.*1400\.00/)
  })

  it('accepts a mismatch within tolerance', () => {
    const issues = validateDocument(
      [money('subtotal', 1200), money('tax_total', 240), money('grand_total', 1440.02)],
      [rule],
      CONTEXT,
    )
    assert.equal(issues.length, 0)
  })

  it('treats missing tax as zero', () => {
    const issues = validateDocument(
      [money('subtotal', 1200), money('tax_total', null), money('grand_total', 1200)],
      [rule],
      CONTEXT,
    )
    assert.equal(issues.length, 0)
  })

  it('leaves a missing total to the required-field check', () => {
    const issues = validateDocument(
      [money('subtotal', 1200), money('tax_total', 240), money('grand_total', null)],
      [rule],
      CONTEXT,
    )
    assert.equal(issues.length, 0)
  })
})

describe('date ranges', () => {
  it('limits invoice date to today plus seven days', () => {
    const rule: ValidationRule = {
      id: 'invoice_date_future',
      type: 'date_offset',
      severity: 'warning',
      field: 'invoice_date',
      maxDaysFromToday: 7,
    }
    const ok = validateDocument(
      [field({ name: 'invoice_date', valueType: 'date', normalizedValue: '2026-07-27' })],
      [rule],
      CONTEXT,
    )
    assert.equal(ok.length, 0)

    const late = validateDocument(
      [field({ name: 'invoice_date', valueType: 'date', normalizedValue: '2026-07-28' })],
      [rule],
      CONTEXT,
    )
    assert.equal(late.length, 1)
    assert.equal(late[0]!.expected, 'no later than 2026-07-27')
  })

  it('requires due date on or after invoice date', () => {
    const rule: ValidationRule = {
      id: 'due_after_invoice',
      type: 'date_order',
      severity: 'warning',
      field: 'due_date',
      notEarlierThan: 'invoice_date',
    }
    const fields = [
      field({
        name: 'invoice_date',
        label: 'Invoice date',
        valueType: 'date',
        normalizedValue: '2026-07-15',
      }),
      field({
        name: 'due_date',
        label: 'Due date',
        valueType: 'date',
        normalizedValue: '2026-07-10',
      }),
    ]
    const issues = validateDocument(fields, [rule], CONTEXT)
    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.actual, '2026-07-10')
  })
})

describe('allowed values and numeric ranges', () => {
  it('rejects a currency outside the allowed values', () => {
    const rule: ValidationRule = {
      id: 'currency_allowed',
      type: 'enum',
      severity: 'blocking',
      field: 'currency',
      values: ['EUR', 'USD', 'GBP'],
    }
    const issues = validateDocument(
      [field({ name: 'currency', normalizedValue: 'RUB' })],
      [rule],
      CONTEXT,
    )
    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.expected, 'one of: EUR, USD, GBP')
  })

  it('rejects a negative amount', () => {
    const rule: ValidationRule = {
      id: 'subtotal_non_negative',
      type: 'number_range',
      severity: 'blocking',
      field: 'subtotal',
      min: 0,
    }
    assert.equal(validateDocument([money('subtotal', -5)], [rule], CONTEXT).length, 1)
    assert.equal(validateDocument([money('subtotal', 0)], [rule], CONTEXT).length, 0)
  })
})

describe('other rules', () => {
  it('uses configured rule text instead of generated text', () => {
    const rule: ValidationRule = {
      id: 'custom',
      type: 'enum',
      severity: 'info',
      field: 'currency',
      values: ['EUR'],
      message: 'Only euros are accepted',
    }
    const issues = validateDocument(
      [field({ name: 'currency', normalizedValue: 'USD' })],
      [rule],
      CONTEXT,
    )
    assert.equal(issues[0]!.message, 'Only euros are accepted')
  })

  it('accepts an array or missing line_items but not a string', () => {
    const rule: ValidationRule = {
      id: 'line_items_shape',
      type: 'array_or_absent',
      severity: 'warning',
      field: 'line_items',
    }
    assert.equal(
      validateDocument(
        [
          field({
            name: 'line_items',
            valueType: 'array',
            normalizedValue: [
              { description: 'Item', quantity: null, unit_price: null, amount: null },
            ],
          }),
        ],
        [rule],
        CONTEXT,
      ).length,
      0,
    )
    assert.equal(
      validateDocument([field({ name: 'line_items', normalizedValue: null })], [rule], CONTEXT)
        .length,
      0,
    )
    assert.equal(
      validateDocument([field({ name: 'line_items', normalizedValue: 'none' })], [rule], CONTEXT)
        .length,
      1,
    )
  })

  it('does not crash on a rule for a missing field', () => {
    const rule: ValidationRule = {
      id: 'ghost',
      type: 'regex',
      severity: 'warning',
      field: 'nonexistent',
      pattern: '^x$',
    }
    assert.equal(validateDocument([], [rule], CONTEXT).length, 0)
  })
})

it('enum fields enforce the values of their schema version', () => {
  const value = field({
    name: 'state',
    valueType: 'enum',
    normalizedValue: 'sent',
    rawValue: 'sent',
    enumValues: ['draft', 'approved'],
  })
  assert.equal(validateDocument([value], [], { today: '2026-09-06' })[0]?.ruleId, 'type:state')
  assert.equal(
    validateDocument([{ ...value, enumValues: ['sent'] }], [], { today: '2026-09-06' }).length,
    0,
  )
})
