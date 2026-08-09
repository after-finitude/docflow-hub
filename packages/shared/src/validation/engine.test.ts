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
    rawValue: String(value),
  })
}

describe('обязательность', () => {
  it('пропуск критичного обязательного поля блокирует', () => {
    const issues = validateDocument(
      [field({ name: 'supplier_name', isRequired: true, isCritical: true })],
      [],
      CONTEXT,
    )
    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.severity, 'blocking')
  })

  it('пропуск некритичного обязательного поля даёт предупреждение', () => {
    const issues = validateDocument([field({ name: 'subject', isRequired: true })], [], CONTEXT)
    assert.equal(issues[0]!.severity, 'warning')
  })

  it('заполненное поле не создаёт проблемы', () => {
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

  it('пустой массив позиций считается незаполненным', () => {
    const issues = validateDocument(
      [field({ name: 'line_items', valueType: 'array', isRequired: true, normalizedValue: [] })],
      [],
      CONTEXT,
    )
    assert.equal(issues.length, 1)
  })
})

describe('арифметика сумм (ТЗ §13, blocking)', () => {
  const rule: ValidationRule = {
    id: 'invoice_totals',
    type: 'sum',
    severity: 'blocking',
    target: 'grand_total',
    operands: ['subtotal', 'tax_total'],
    tolerance: 0.02,
  }

  it('сходящиеся суммы не создают проблем', () => {
    const issues = validateDocument(
      [money('subtotal', 1200), money('tax_total', 240), money('grand_total', 1440)],
      [rule],
      CONTEXT,
    )
    assert.equal(issues.length, 0)
  })

  it('расхождение даёт blocking с ожидаемым и фактическим значением', () => {
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

  it('расхождение в пределах допуска принимается', () => {
    const issues = validateDocument(
      [money('subtotal', 1200), money('tax_total', 240), money('grand_total', 1440.02)],
      [rule],
      CONTEXT,
    )
    assert.equal(issues.length, 0)
  })

  it('отсутствующий налог считается нулём, а не ошибкой', () => {
    const issues = validateDocument(
      [money('subtotal', 1200), money('tax_total', null), money('grand_total', 1200)],
      [rule],
      CONTEXT,
    )
    assert.equal(issues.length, 0)
  })

  it('без итоговой суммы правило молчит: об этом скажет проверка обязательности', () => {
    const issues = validateDocument(
      [money('subtotal', 1200), money('tax_total', 240), money('grand_total', null)],
      [rule],
      CONTEXT,
    )
    assert.equal(issues.length, 0)
  })
})

describe('диапазоны дат', () => {
  it('дата инвойса не позже сегодня + 7 дней', () => {
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
    assert.equal(late[0]!.expected, 'не позже 2026-07-27')
  })

  it('срок оплаты не раньше даты инвойса', () => {
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
        label: 'Дата инвойса',
        valueType: 'date',
        normalizedValue: '2026-07-15',
      }),
      field({
        name: 'due_date',
        label: 'Срок оплаты',
        valueType: 'date',
        normalizedValue: '2026-07-10',
      }),
    ]
    const issues = validateDocument(fields, [rule], CONTEXT)
    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.actual, '2026-07-10')
  })
})

describe('справочник значений и диапазоны чисел', () => {
  it('валюта вне справочника отклоняется', () => {
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
    assert.equal(issues[0]!.expected, 'одно из: EUR, USD, GBP')
  })

  it('отрицательная сумма отклоняется', () => {
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

describe('прочее', () => {
  it('текст правила из конфигурации перекрывает сгенерированный', () => {
    const rule: ValidationRule = {
      id: 'custom',
      type: 'enum',
      severity: 'info',
      field: 'currency',
      values: ['EUR'],
      message: 'Принимаем только евро',
    }
    const issues = validateDocument(
      [field({ name: 'currency', normalizedValue: 'USD' })],
      [rule],
      CONTEXT,
    )
    assert.equal(issues[0]!.message, 'Принимаем только евро')
  })

  it('line_items принимает массив и отсутствие, но не строку', () => {
    const rule: ValidationRule = {
      id: 'line_items_shape',
      type: 'array_or_absent',
      severity: 'warning',
      field: 'line_items',
    }
    assert.equal(
      validateDocument([field({ name: 'line_items', normalizedValue: [{}] })], [rule], CONTEXT)
        .length,
      0,
    )
    assert.equal(
      validateDocument([field({ name: 'line_items', normalizedValue: null })], [rule], CONTEXT)
        .length,
      0,
    )
    assert.equal(
      validateDocument([field({ name: 'line_items', normalizedValue: 'нет' })], [rule], CONTEXT)
        .length,
      1,
    )
  })

  it('правило на несуществующее поле не роняет движок', () => {
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
