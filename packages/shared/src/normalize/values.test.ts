import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeAmount, normalizeByType, normalizeCurrency, normalizeDate } from './values'

describe('normalizeDate', () => {
  it('ISO остаётся ISO', () => {
    assert.equal(normalizeDate('2026-07-15'), '2026-07-15')
  })
  it('европейские форматы', () => {
    assert.equal(normalizeDate('15.07.2026'), '2026-07-15')
    assert.equal(normalizeDate('5/7/2026'), '2026-07-05')
    assert.equal(normalizeDate('15-07-2026'), '2026-07-15')
  })
  it('словесные месяцы', () => {
    assert.equal(normalizeDate('15 июля 2026'), '2026-07-15')
    assert.equal(normalizeDate('15 июля 2026 г.'), '2026-07-15')
    assert.equal(normalizeDate('July 15, 2026'), '2026-07-15')
    assert.equal(normalizeDate('15 July 2026'), '2026-07-15')
  })
  it('несуществующие даты отклоняются', () => {
    assert.equal(normalizeDate('31.02.2026'), null)
    assert.equal(normalizeDate('2026-13-01'), null)
    assert.equal(normalizeDate('не дата'), null)
  })
})

describe('normalizeAmount', () => {
  it('русский формат с пробелами тысяч', () => {
    assert.equal(normalizeAmount('1 200,00'), 1200)
    assert.equal(normalizeAmount('12 345 678,90'), 12345678.9)
  })
  it('английский формат с запятыми тысяч', () => {
    assert.equal(normalizeAmount('1,200.00'), 1200)
    assert.equal(normalizeAmount('1,234,567.89'), 1234567.89)
  })
  it('немецкий формат: точки тысяч, запятая десятичных', () => {
    assert.equal(normalizeAmount('1.200,50'), 1200.5)
  })
  it('ровно три цифры после разделителя — это тысячи', () => {
    assert.equal(normalizeAmount('1.200'), 1200)
    assert.equal(normalizeAmount('1,200'), 1200)
  })
  it('валютные символы по краям не мешают', () => {
    assert.equal(normalizeAmount('€1200.00'), 1200)
    assert.equal(normalizeAmount('1200.00 EUR'), 1200)
    assert.equal(normalizeAmount('$ 99.90'), 99.9)
  })
  it('отрицательные и мусор', () => {
    assert.equal(normalizeAmount('-500,25'), -500.25)
    assert.equal(normalizeAmount('нет суммы'), null)
    assert.equal(normalizeAmount(''), null)
  })
})

describe('normalizeCurrency', () => {
  it('коды, символы и слова', () => {
    assert.equal(normalizeCurrency('EUR'), 'EUR')
    assert.equal(normalizeCurrency('€'), 'EUR')
    assert.equal(normalizeCurrency('евро'), 'EUR')
    assert.equal(normalizeCurrency('$'), 'USD')
    assert.equal(normalizeCurrency('руб.'), 'RUB')
    assert.equal(normalizeCurrency('chf'), 'CHF')
  })
  it('мусор отклоняется', () => {
    assert.equal(normalizeCurrency('не валюта'), null)
  })
})

describe('normalizeByType', () => {
  it('маршрутизирует по типу поля', () => {
    assert.equal(normalizeByType('15.07.2026', 'date'), '2026-07-15')
    assert.equal(normalizeByType('1 200,00', 'number'), 1200)
    assert.equal(normalizeByType('€', 'currency'), 'EUR')
    assert.equal(normalizeByType('да', 'boolean'), true)
    assert.equal(normalizeByType('  текст  ', 'string'), 'текст')
    assert.equal(normalizeByType('', 'string'), null)
  })
})
