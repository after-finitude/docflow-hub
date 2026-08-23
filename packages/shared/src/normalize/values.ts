import type { ValueType } from '../enums'

/**
 * Normalize extracted values (spec 6.4): ISO dates, numeric amounts, and ISO
 * 4217 currency codes. Code rather than the LLM keeps this deterministic and
 * testable. null means conversion failed.
 */

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

// Unicode escapes keep the source English-only while preserving support for
// Russian-language documents already accepted by the pipeline.
const MONTHS_RU: Record<string, number> = {
  '\u044f\u043d\u0432\u0430\u0440\u044f': 1,
  '\u0444\u0435\u0432\u0440\u0430\u043b\u044f': 2,
  '\u043c\u0430\u0440\u0442\u0430': 3,
  '\u0430\u043f\u0440\u0435\u043b\u044f': 4,
  '\u043c\u0430\u044f': 5,
  '\u0438\u044e\u043d\u044f': 6,
  '\u0438\u044e\u043b\u044f': 7,
  '\u0430\u0432\u0433\u0443\u0441\u0442\u0430': 8,
  '\u0441\u0435\u043d\u0442\u044f\u0431\u0440\u044f': 9,
  '\u043e\u043a\u0442\u044f\u0431\u0440\u044f': 10,
  '\u043d\u043e\u044f\u0431\u0440\u044f': 11,
  '\u0434\u0435\u043a\u0430\u0431\u0440\u044f': 12,
}

const CURRENCY_ALIASES: Record<string, string> = {
  eur: 'EUR',
  '€': 'EUR',
  '\u0435\u0432\u0440\u043e': 'EUR',
  euro: 'EUR',
  usd: 'USD',
  $: 'USD',
  '\u0434\u043e\u043b\u043b\u0430\u0440': 'USD',
  '\u0434\u043e\u043b\u043b\u0430\u0440\u043e\u0432': 'USD',
  dollar: 'USD',
  gbp: 'GBP',
  '£': 'GBP',
  '\u0444\u0443\u043d\u0442': 'GBP',
  pound: 'GBP',
  rub: 'RUB',
  '₽': 'RUB',
  '\u0440\u0443\u0431': 'RUB',
  '\u0440\u0443\u0431.': 'RUB',
  '\u0440\u0443\u0431\u043b\u0435\u0439': 'RUB',
}

/** Date → 'YYYY-MM-DD'. */
export function normalizeDate(raw: string): string | null {
  const text = raw.trim().toLowerCase()

  // ISO: 2026-07-15
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]))

  // European order: 15.07.2026, 15/07/2026, 15-07-2026
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text)
  if (m) return validDate(Number(m[3]), Number(m[2]), Number(m[1]))

  // Written month: “15 July 2026” and its supported Russian equivalent.
  m = /^(\d{1,2})\s+([a-z\u0400-\u04ff]+),?\s+(\d{4})/.exec(text)
  if (m) {
    const month = MONTHS_EN[m[2]!] ?? MONTHS_RU[m[2]!]
    if (month) return validDate(Number(m[3]), month, Number(m[1]))
  }

  // American written form: “July 15, 2026”.
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
 * Amount → number. Supports “1 200,00”, “1,200.00”, “1200.00”, and “1.200,00”.
 * The final dot or comma followed by one or two digits is the decimal separator.
 */
export function normalizeAmount(raw: string): number | null {
  let text = raw.trim().replace(/[\s  ]/g, '')
  // Ignore currency symbols and codes around the amount.
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
    // One or two digits after the final separator are decimals; exactly three
    // digits indicate a thousands separator (1.200 = 1200).
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

/** Currency → ISO 4217 code. */
export function normalizeCurrency(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/\.$/, '')
  if (CURRENCY_ALIASES[text]) return CURRENCY_ALIASES[text]
  if (/^[a-z]{3}$/.test(text)) return text.toUpperCase()
  return null
}

const TRUE_WORDS = new Set(['true', 'yes', '1', '\u0434\u0430'])
const FALSE_WORDS = new Set(['false', 'no', '0', '\u043d\u0435\u0442'])

/** Normalize by schema field type; arrays are normalized in the line-items stage. */
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
