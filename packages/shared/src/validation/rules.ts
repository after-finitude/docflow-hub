import { z } from 'zod'
import { ISSUE_SEVERITIES } from '../enums'

/**
 * Правила валидации (ТЗ 6.6). Хранятся в конфигурации схемы типа и
 * версионируются вместе с ней, поэтому это zod-схемы, а не код.
 *
 * Типы проверок из ТЗ 6.6 покрыты так:
 *   обязательность      — выводится из FieldSpec.required, отдельного правила не нужно;
 *   регулярное выражение — regex;
 *   диапазон дат        — date_offset (относительно сегодня) и date_order (между полями);
 *   формат валюты       — enum поверх нормализованного кода ISO 4217;
 *   арифметика сумм     — sum;
 *   справочник значений — enum;
 *   условия между полями — date_order, number_compare.
 */

const severity = z.enum(ISSUE_SEVERITIES)
const base = { id: z.string().min(1), severity, message: z.string().optional() }

export const validationRuleSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('regex'), field: z.string(), pattern: z.string() }),
  z.object({
    ...base,
    type: z.literal('enum'),
    field: z.string(),
    values: z.array(z.string()).min(1),
  }),
  z.object({
    ...base,
    type: z.literal('number_range'),
    field: z.string(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('number_compare'),
    field: z.string(),
    operator: z.enum(['gte', 'lte', 'gt', 'lt']),
    other: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('date_offset'),
    field: z.string(),
    /** Не позже, чем сегодня + N дней (ТЗ §13: invoice_date). */
    maxDaysFromToday: z.number().int().optional(),
    minDaysFromToday: z.number().int().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('date_order'),
    field: z.string(),
    /** Дата не раньше значения этого поля (ТЗ §13: due_date ≥ invoice_date). */
    notEarlierThan: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('sum'),
    /** target ≈ сумма operands с допуском tolerance (ТЗ §13: blocking). */
    target: z.string(),
    operands: z.array(z.string()).min(2),
    tolerance: z.number().nonnegative(),
  }),
  z.object({ ...base, type: z.literal('array_or_absent'), field: z.string() }),
])

export type ValidationRule = z.infer<typeof validationRuleSchema>

/** Идентификатор правила уникальности invoice_number — единственная cross-document проверка (ТЗ §9). */
export const INVOICE_NUMBER_UNIQUE_RULE = 'invoice_number_unique'

/**
 * Правила, созданные не движком валидации: их не трогает перезапуск.
 * Сейчас это только предупреждение о нескольких документах в одном файле,
 * которое ставит классификация (ТЗ 6.3).
 */
export const EXTERNAL_RULE_IDS = ['multi_document_suspected'] as const
