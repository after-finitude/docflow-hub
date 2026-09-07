import type { IssueSeverity, ValueType } from '../enums'
import type { ValidationRule } from './rules'
import { normalizeDate } from '../normalize/values'
import { bankTransactionSchema, tableValueSchemaFor } from '../contracts/review'

/**
 * Validation engine (spec 6.6). A pure function gives reproducible results
 * (spec 6.7) in both workers and synchronous API field edits.
 */

export interface ValidationField {
  name: string
  label: string
  valueType: ValueType
  rawValue: string | null
  normalizedValue: unknown
  isRequired: boolean
  isCritical: boolean
  enumValues?: string[]
}

export interface ValidationContext {
  /** Current ISO date (YYYY-MM-DD), supplied externally for reproducibility. */
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

  // Required means required for approval, independently of confidence criticality.
  for (const field of fields) {
    if (field.isRequired && isEmpty(field)) {
      issues.push({
        ruleId: `required:${field.name}`,
        fieldName: field.name,
        severity: 'blocking',
        message: `Required field “${field.label}” is empty`,
        expected: 'a value',
        actual: 'empty',
      })
    }
    if (!isEmpty(field) && !hasValidValueType(field)) {
      issues.push({
        ruleId: `type:${field.name}`,
        fieldName: field.name,
        severity: 'blocking',
        message: `Field “${field.label}” has an invalid ${field.valueType} value`,
        expected: field.valueType,
        actual: 'invalid value',
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
              message: `Field “${field.label}” has an invalid format`,
              expected: `match pattern ${rule.pattern}`,
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
              message: `Field “${field.label}” has an unsupported value`,
              expected: `one of: ${rule.values.join(', ')}`,
              actual: value,
            }
      })

    case 'number_range':
      return checkSingle(rule, byName, (field) => {
        const value = asNumber(field.normalizedValue)
        if (value === null) return null
        if (rule.min !== undefined && value < rule.min) {
          return {
            message: `Field “${field.label}” is below the minimum`,
            expected: `at least ${format(rule.min)}`,
            actual: format(value),
          }
        }
        if (rule.max !== undefined && value > rule.max) {
          return {
            message: `Field “${field.label}” is above the maximum`,
            expected: `at most ${format(rule.max)}`,
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

      const words = { gte: 'at least', lte: 'at most', gt: 'greater than', lt: 'less than' }
      return issue(rule, field.name, {
        message: `Field “${field.label}” must be ${words[rule.operator]} field “${other.label}”`,
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
              message: `Date in “${field.label}” is too far in the future`,
              expected: `no later than ${limit}`,
              actual: value,
            }
          }
        }
        if (rule.minDaysFromToday !== undefined) {
          const limit = shiftDate(context.today, rule.minDaysFromToday)
          if (value < limit) {
            return {
              message: `Date in “${field.label}” is too far in the past`,
              expected: `no earlier than ${limit}`,
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
        message: `Date in “${field.label}” is before “${other.label}”`,
        expected: `no earlier than ${otherValue}`,
        actual: value,
      })
    }

    case 'sum': {
      const target = byName.get(rule.target)
      const targetValue = asNumber(target?.normalizedValue)
      if (!target || targetValue === null) return null

      const operands = rule.operands.map((name) => byName.get(name)).filter(isPresent)
      // Treat a missing operand as zero because tax may be omitted legitimately.
      const sum = operands.reduce((acc, field) => acc + (asNumber(field.normalizedValue) ?? 0), 0)
      if (Math.abs(sum - targetValue) <= rule.tolerance) return null

      const breakdown = operands
        .map((field) => `${field.label} ${format(asNumber(field.normalizedValue) ?? 0)}`)
        .join(' + ')
      return issue(rule, target.name, {
        message: `Amounts do not match: ${breakdown} = ${format(sum)}, but “${target.label}” = ${format(targetValue)}`,
        expected: format(sum),
        actual: format(targetValue),
      })
    }

    case 'statement_balance': {
      const parsed = bankTransactionSchema
        .array()
        .safeParse(byName.get(rule.field)?.normalizedValue)
      if (!parsed.success) return null // Missing/invalid tables are handled by field validation.
      const rows = parsed.data
      let credits = 0
      let debits = 0
      for (const [index, row] of rows.entries()) {
        if (
          !row.date?.trim() ||
          !row.description.trim() ||
          (row.credit === null && row.debit === null) ||
          ((row.credit ?? 0) > 0 && (row.debit ?? 0) > 0)
        ) {
          return issue(rule, rule.field, {
            message: `Transaction ${index + 1} needs a date, description and an unambiguous paid-in or paid-out amount`,
            expected: 'a complete transaction',
            actual: `row ${index + 1}`,
          })
        }
        // Only validate the calendar date here; keep the printed numeric order in the row.
        if (!normalizeDate(row.date!) && !normalizeDate(row.date!, 'mdy')) {
          return issue(rule, rule.field, {
            message: `Transaction ${index + 1} has an invalid or unsupported date; enter a complete date such as YYYY-MM-DD`,
            expected: 'a valid calendar date with a year',
            actual: `row ${index + 1}`,
          })
        }
        credits += row.credit ?? 0
        debits += row.debit ?? 0
      }
      // Check aggregate balances independent of whether the bank prints newest or oldest first.
      const opening = asNumber(byName.get(rule.opening)?.normalizedValue)
      const closing = asNumber(byName.get(rule.closing)?.normalizedValue)
      const comparisons = [
        {
          label: 'Closing balance',
          actual: closing,
          expected: opening === null ? null : opening + credits - debits,
        },
        {
          label: 'Total paid in',
          actual: asNumber(byName.get(rule.creditTotal)?.normalizedValue),
          expected: credits,
        },
        {
          label: 'Total paid out',
          actual: asNumber(byName.get(rule.debitTotal)?.normalizedValue),
          expected: debits,
        },
      ]
      for (const comparison of comparisons) {
        if (
          comparison.actual !== null &&
          comparison.expected !== null &&
          Math.abs(comparison.actual - comparison.expected) > rule.tolerance + 1e-9
        ) {
          return issue(rule, rule.field, {
            message: `${comparison.label} does not match the transactions; review amounts and missing or repeated rows`,
            expected: format(comparison.expected),
            actual: format(comparison.actual),
          })
        }
      }
      return null
    }

    case 'array_or_absent':
      return checkSingle(rule, byName, (field) => {
        // Accept either an array or an explicit missing value (spec §13).
        if (field.normalizedValue === null || Array.isArray(field.normalizedValue)) return null
        return {
          message: `Field “${field.label}” must contain line items or be explicitly absent`,
          expected: 'a line-item array or no value',
          actual: typeof field.normalizedValue,
        }
      })
  }
}

/** Wrapper for single-field rules; skip absent fields. */
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
    // Configured rule text overrides generated text.
    message: rule.message ?? detail.message,
    expected: detail.expected,
    actual: detail.actual,
  }
}

function isEmpty(field: ValidationField): boolean {
  if (field.normalizedValue === null || field.normalizedValue === undefined) {
    return field.rawValue === null || field.rawValue.trim() === ''
  }
  if (Array.isArray(field.normalizedValue))
    return field.name !== 'transactions' && field.normalizedValue.length === 0
  return String(field.normalizedValue).trim() === ''
}

function hasValidValueType(field: ValidationField): boolean {
  const value = field.normalizedValue
  switch (field.valueType) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return tableValueSchemaFor(field.name).safeParse(value).success
    case 'date':
      return typeof value === 'string' && normalizeDate(value) === value
    case 'enum':
      return typeof value === 'string' && (!field.enumValues || field.enumValues.includes(value))
    case 'currency':
      return typeof value === 'string' && /^[A-Z]{3}$/.test(value)
    default:
      return typeof value === 'string'
  }
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

/** Shift an ISO date by days without time zones. */
function shiftDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
