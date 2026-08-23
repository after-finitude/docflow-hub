import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeAmount, normalizeByType, normalizeCurrency, normalizeDate } from './values'

describe('normalizeDate', () => {
  it('keeps ISO as ISO', () => {
    assert.equal(normalizeDate('2026-07-15'), '2026-07-15')
  })
  it('supports European formats', () => {
    assert.equal(normalizeDate('15.07.2026'), '2026-07-15')
    assert.equal(normalizeDate('5/7/2026'), '2026-07-05')
    assert.equal(normalizeDate('15-07-2026'), '2026-07-15')
  })
  it('supports written months', () => {
    assert.equal(normalizeDate('15 \u0438\u044e\u043b\u044f 2026'), '2026-07-15')
    assert.equal(normalizeDate('15 \u0438\u044e\u043b\u044f 2026 \u0433.'), '2026-07-15')
    assert.equal(normalizeDate('15 July 2026'), '2026-07-15')
    assert.equal(normalizeDate('July 15, 2026'), '2026-07-15')
  })
  it('rejects invalid dates', () => {
    assert.equal(normalizeDate('31.02.2026'), null)
    assert.equal(normalizeDate('2026-13-01'), null)
    assert.equal(normalizeDate('not a date'), null)
  })
})

describe('normalizeAmount', () => {
  it('supports spaces as thousands separators', () => {
    assert.equal(normalizeAmount('1 200,00'), 1200)
    assert.equal(normalizeAmount('12 345 678,90'), 12345678.9)
  })
  it('supports commas as thousands separators', () => {
    assert.equal(normalizeAmount('1,200.00'), 1200)
    assert.equal(normalizeAmount('1,234,567.89'), 1234567.89)
  })
  it('supports German thousands and decimal separators', () => {
    assert.equal(normalizeAmount('1.200,50'), 1200.5)
  })
  it('treats exactly three digits after a separator as thousands', () => {
    assert.equal(normalizeAmount('1.200'), 1200)
    assert.equal(normalizeAmount('1,200'), 1200)
  })
  it('ignores surrounding currency symbols', () => {
    assert.equal(normalizeAmount('€1200.00'), 1200)
    assert.equal(normalizeAmount('1200.00 EUR'), 1200)
    assert.equal(normalizeAmount('$ 99.90'), 99.9)
  })
  it('supports negatives and rejects garbage', () => {
    assert.equal(normalizeAmount('-500,25'), -500.25)
    assert.equal(normalizeAmount('no amount'), null)
    assert.equal(normalizeAmount(''), null)
  })
})

describe('normalizeCurrency', () => {
  it('supports codes, symbols, and words', () => {
    assert.equal(normalizeCurrency('EUR'), 'EUR')
    assert.equal(normalizeCurrency('€'), 'EUR')
    assert.equal(normalizeCurrency('\u0435\u0432\u0440\u043e'), 'EUR')
    assert.equal(normalizeCurrency('euro'), 'EUR')
    assert.equal(normalizeCurrency('$'), 'USD')
    assert.equal(normalizeCurrency('\u0440\u0443\u0431.'), 'RUB')
    assert.equal(normalizeCurrency('rub'), 'RUB')
    assert.equal(normalizeCurrency('chf'), 'CHF')
  })
  it('rejects garbage', () => {
    assert.equal(normalizeCurrency('not a currency'), null)
  })
})

describe('normalizeByType', () => {
  it('dispatches by field type', () => {
    assert.equal(normalizeByType('15.07.2026', 'date'), '2026-07-15')
    assert.equal(normalizeByType('1 200,00', 'number'), 1200)
    assert.equal(normalizeByType('€', 'currency'), 'EUR')
    assert.equal(normalizeByType('\u0434\u0430', 'boolean'), true)
    assert.equal(normalizeByType('yes', 'boolean'), true)
    assert.equal(normalizeByType('  text  ', 'string'), 'text')
    assert.equal(normalizeByType('', 'string'), null)
  })
})
