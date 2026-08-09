import type { IssueSeverity, ValueType } from '../enums'
import type { ValidationRule } from './rules'

/**
 * Движок валидации (ТЗ 6.6). Чистая функция: одни и те же входные данные
 * дают один и тот же результат, поэтому решение воспроизводимо (ТЗ 6.7).
 * Работает и в воркере, и синхронно в API при правке поля.
 */

export interface ValidationField {
  name: string
  label: string
  valueType: ValueType
  rawValue: string | null
  normalizedValue: unknown
  isRequired: boolean
  isCritical: boolean
}

export interface ValidationContext {
  /** Сегодняшняя дата в ISO (YYYY-MM-DD). Передаётся снаружи ради воспроизводимости. */
  today: string
}

export interface ValidationIssueResult {
  ruleId: string
  fieldName: string | null
  severity: IssueSeverity
  message: string
  expected: string | null
  actual: string | null
}

export function validateDocument(
  fields: ValidationField[],
  rules: ValidationRule[],
  context: ValidationContext,
): ValidationIssueResult[] {
  const byName = new Map(fields.map((field) => [field.name, field]))
  const issues: ValidationIssueResult[] = []

  // Обязательность выводится из конфигурации схемы, а не дублируется правилами.
  // Пропуск критичного поля блокирует подтверждение, некритичного — предупреждает.
  for (const field of fields) {
    if (field.isRequired && isEmpty(field)) {
      issues.push({
        ruleId: `required:${field.name}`,
        fieldName: field.name,
        severity: field.isCritical ? 'blocking' : 'warning',
        message: `Обязательное поле «${field.label}» не заполнено`,
        expected: 'значение указано',
        actual: 'пусто',
      })
    }
  }

  for (const rule of rules) {
    const result = applyRule(rule, byName, context)
    if (result) issues.push(result)
  }

  return issues
}

function applyRule(
  rule: ValidationRule,
  byName: Map<string, ValidationField>,
  context: ValidationContext,
): ValidationIssueResult | null {
  switch (rule.type) {
    case 'regex':
      return checkSingle(rule, byName, (field) => {
        const value = asString(field.normalizedValue) ?? field.rawValue
        if (value === null) return null
        return new RegExp(rule.pattern).test(value)
          ? null
          : {
              message: `Значение поля «${field.label}» имеет неверный формат`,
              expected: `соответствие шаблону ${rule.pattern}`,
              actual: value,
            }
      })

    case 'enum':
      return checkSingle(rule, byName, (field) => {
        const value = asString(field.normalizedValue)
        if (value === null) return null
        return rule.values.includes(value)
          ? null
          : {
              message: `Недопустимое значение поля «${field.label}»`,
              expected: `одно из: ${rule.values.join(', ')}`,
              actual: value,
            }
      })

    case 'number_range':
      return checkSingle(rule, byName, (field) => {
        const value = asNumber(field.normalizedValue)
        if (value === null) return null
        if (rule.min !== undefined && value < rule.min) {
          return {
            message: `Значение поля «${field.label}» меньше допустимого`,
            expected: `не меньше ${format(rule.min)}`,
            actual: format(value),
          }
        }
        if (rule.max !== undefined && value > rule.max) {
          return {
            message: `Значение поля «${field.label}» больше допустимого`,
            expected: `не больше ${format(rule.max)}`,
            actual: format(value),
          }
        }
        return null
      })

    case 'number_compare': {
      const field = byName.get(rule.field)
      const other = byName.get(rule.other)
      const value = asNumber(field?.normalizedValue)
      const otherValue = asNumber(other?.normalizedValue)
      if (!field || !other || value === null || otherValue === null) return null

      const ok = {
        gte: value >= otherValue,
        lte: value <= otherValue,
        gt: value > otherValue,
        lt: value < otherValue,
      }[rule.operator]
      if (ok) return null

      const words = { gte: 'не меньше', lte: 'не больше', gt: 'больше', lt: 'меньше' }
      return issue(rule, field.name, {
        message: `Поле «${field.label}» должно быть ${words[rule.operator]} поля «${other.label}»`,
        expected: `${words[rule.operator]} ${format(otherValue)}`,
        actual: format(value),
      })
    }

    case 'date_offset':
      return checkSingle(rule, byName, (field) => {
        const value = asString(field.normalizedValue)
        if (value === null) return null

        if (rule.maxDaysFromToday !== undefined) {
          const limit = shiftDate(context.today, rule.maxDaysFromToday)
          if (value > limit) {
            return {
              message: `Дата в поле «${field.label}» слишком далеко в будущем`,
              expected: `не позже ${limit}`,
              actual: value,
            }
          }
        }
        if (rule.minDaysFromToday !== undefined) {
          const limit = shiftDate(context.today, rule.minDaysFromToday)
          if (value < limit) {
            return {
              message: `Дата в поле «${field.label}» слишком далеко в прошлом`,
              expected: `не раньше ${limit}`,
              actual: value,
            }
          }
        }
        return null
      })

    case 'date_order': {
      const field = byName.get(rule.field)
      const other = byName.get(rule.notEarlierThan)
      const value = asString(field?.normalizedValue)
      const otherValue = asString(other?.normalizedValue)
      if (!field || !other || value === null || otherValue === null) return null
      if (value >= otherValue) return null

      return issue(rule, field.name, {
        message: `Дата в поле «${field.label}» раньше даты в поле «${other.label}»`,
        expected: `не раньше ${otherValue}`,
        actual: value,
      })
    }

    case 'sum': {
      const target = byName.get(rule.target)
      const targetValue = asNumber(target?.normalizedValue)
      if (!target || targetValue === null) return null

      const operands = rule.operands.map((name) => byName.get(name)).filter(isPresent)
      // Отсутствующее слагаемое считается нулём: налог может не указываться,
      // и это не повод объявлять суммы несходящимися.
      const sum = operands.reduce((acc, field) => acc + (asNumber(field.normalizedValue) ?? 0), 0)
      if (Math.abs(sum - targetValue) <= rule.tolerance) return null

      const breakdown = operands
        .map((field) => `${field.label} ${format(asNumber(field.normalizedValue) ?? 0)}`)
        .join(' + ')
      return issue(rule, target.name, {
        message: `Суммы не сходятся: ${breakdown} = ${format(sum)}, а «${target.label}» = ${format(targetValue)}`,
        expected: format(sum),
        actual: format(targetValue),
      })
    }

    case 'array_or_absent':
      return checkSingle(rule, byName, (field) => {
        // Либо массив, либо явный признак отсутствия (ТЗ §13).
        if (field.normalizedValue === null || Array.isArray(field.normalizedValue)) return null
        return {
          message: `Поле «${field.label}» должно быть таблицей позиций или явно отсутствовать`,
          expected: 'массив позиций либо отсутствие значения',
          actual: typeof field.normalizedValue,
        }
      })
  }
}

/** Обёртка для правил по одному полю: отсутствующее поле не проверяется. */
function checkSingle(
  rule: ValidationRule & { field: string },
  byName: Map<string, ValidationField>,
  check: (
    field: ValidationField,
  ) => Omit<ValidationIssueResult, 'ruleId' | 'fieldName' | 'severity'> | null,
): ValidationIssueResult | null {
  const field = byName.get(rule.field)
  if (!field) return null
  const result = check(field)
  return result ? issue(rule, field.name, result) : null
}

function issue(
  rule: ValidationRule,
  fieldName: string,
  detail: Omit<ValidationIssueResult, 'ruleId' | 'fieldName' | 'severity'>,
): ValidationIssueResult {
  return {
    ruleId: rule.id,
    fieldName,
    severity: rule.severity,
    // Текст правила из конфигурации имеет приоритет над сгенерированным.
    message: rule.message ?? detail.message,
    expected: detail.expected,
    actual: detail.actual,
  }
}

function isEmpty(field: ValidationField): boolean {
  if (field.normalizedValue === null || field.normalizedValue === undefined) {
    return field.rawValue === null || field.rawValue.trim() === ''
  }
  if (Array.isArray(field.normalizedValue)) return field.normalizedValue.length === 0
  return String(field.normalizedValue).trim() === ''
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}

function format(value: number): string {
  return value.toFixed(2)
}

/** Сдвиг ISO-даты на дни без часовых поясов. */
function shiftDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
