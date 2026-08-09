import type { ValueType } from '../enums'

/**
 * Нормализация извлечённых значений (ТЗ 6.4): даты в ISO, суммы в number,
 * валюта в ISO 4217. Выполняется кодом, а не LLM: детерминированно и
 * тестируемо. null — значение не удалось привести к типу.
 */

const MONTHS_RU: Record<string, number> = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
}

const MONTHS_EN: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
}

const CURRENCY_ALIASES: Record<string, string> = {
  eur: 'EUR',
  '€': 'EUR',
  евро: 'EUR',
  euro: 'EUR',
  usd: 'USD',
  $: 'USD',
  доллар: 'USD',
  долларов: 'USD',
  dollar: 'USD',
  gbp: 'GBP',
  '£': 'GBP',
  фунт: 'GBP',
  pound: 'GBP',
  rub: 'RUB',
  '₽': 'RUB',
  руб: 'RUB',
  'руб.': 'RUB',
  рублей: 'RUB',
}

/** Дата → 'YYYY-MM-DD'. */
export function normalizeDate(raw: string): string | null {
  const text = raw.trim().toLowerCase()

  // ISO: 2026-07-15
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]))

  // Европейский порядок: 15.07.2026, 15/07/2026, 15-07-2026
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text)
  if (m) return validDate(Number(m[3]), Number(m[2]), Number(m[1]))

  // Словесный месяц: «15 июля 2026», «15 july 2026» (с необязательными «г.», запятой)
  m = /^(\d{1,2})\s+([а-яa-z]+),?\s+(\d{4})/.exec(text)
  if (m) {
    const month = MONTHS_RU[m[2]!] ?? MONTHS_EN[m[2]!]
    if (month) return validDate(Number(m[3]), month, Number(m[1]))
  }

  // Американский словесный: «july 15, 2026»
  m = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(text)
  if (m) {
    const month = MONTHS_EN[m[1]!]
    if (month) return validDate(Number(m[3]), month, Number(m[2]))
  }

  return null
}

function validDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Сумма → number. Понимает «1 200,00», «1,200.00», «1200.00», «1.200,00».
 * Десятичный разделитель — последняя точка или запятая с 1–2 цифрами после.
 */
export function normalizeAmount(raw: string): number | null {
  let text = raw.trim().replace(/[\s  ]/g, '')
  // Валютные символы и коды по краям не мешают сумме.
  text = text.replace(/^[^\d+-]+/, '').replace(/[^\d.,]+$/, '')
  if (!/\d/.test(text)) return null

  const negative = text.startsWith('-')
  text = text.replace(/^[+-]/, '')

  const lastComma = text.lastIndexOf(',')
  const lastDot = text.lastIndexOf('.')
  const separator = Math.max(lastComma, lastDot)

  let integerPart = text
  let fractionPart = ''
  if (separator !== -1) {
    const after = text.slice(separator + 1)
    // 1–2 цифры после последнего разделителя — десятичная часть;
    // ровно 3 — разделитель тысяч (1.200 = 1200).
    if (/^\d{1,2}$/.test(after)) {
      integerPart = text.slice(0, separator)
      fractionPart = after
    }
  }

  integerPart = integerPart.replace(/[.,]/g, '')
  if (!/^\d+$/.test(integerPart)) return null

  const value = Number(`${integerPart}.${fractionPart || '0'}`)
  return negative ? -value : value
}

/** Валюта → код ISO 4217. */
export function normalizeCurrency(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/\.$/, '')
  if (CURRENCY_ALIASES[text]) return CURRENCY_ALIASES[text]
  if (/^[a-z]{3}$/.test(text)) return text.toUpperCase()
  return null
}

const TRUE_WORDS = new Set(['true', 'да', 'yes', '1'])
const FALSE_WORDS = new Set(['false', 'нет', 'no', '0'])

/** Значение по типу поля схемы. Для array нормализация — на этапе line items. */
export function normalizeByType(raw: string, type: ValueType): unknown {
  switch (type) {
    case 'string':
    case 'enum':
      return raw.trim() || null
    case 'number':
      return normalizeAmount(raw)
    case 'currency':
      return normalizeCurrency(raw)
    case 'date':
      return normalizeDate(raw)
    case 'boolean': {
      const text = raw.trim().toLowerCase()
      if (TRUE_WORDS.has(text)) return true
      if (FALSE_WORDS.has(text)) return false
      return null
    }
    case 'array':
      return null
  }
}
