import type { DocumentType, SourceType } from '../enums'
import type { BoundingBox } from '../contracts/ocr'
import type { LineItem } from '../contracts/review'

/**
 * Канонический JSON (ТЗ 6.8): единое представление результата, не зависящее
 * от конкретного адаптера назначения. Включает правки оператора и версию
 * схемы, по которой документ извлекался.
 */

export const CANONICAL_FORMAT_VERSION = 1

export interface CanonicalFieldValue {
  /** Нормализованное значение — то, что уходит во внешнюю систему. */
  value: unknown
  /** Как записано в документе; null для отсутствующих и введённых вручную. */
  raw: string | null
  confidence: number | null
  edited: boolean
  source: { page: number; bbox: BoundingBox } | null
}

export interface CanonicalDocument {
  formatVersion: number
  documentId: string
  documentType: DocumentType
  schemaVersion: number | null
  source: {
    type: SourceType
    originalFilename: string
    checksum: string
    receivedAt: string
  }
  fields: Record<string, CanonicalFieldValue>
  lineItems: LineItem[] | null
  /** Непогашенные предупреждения: подтверждению они не мешали, но контекст важен. */
  warnings: Array<{ ruleId: string; fieldName: string | null; message: string }>
  approvedAt: string | null
  generatedAt: string
}

export interface CanonicalInputField {
  name: string
  valueType: string
  rawValue: string | null
  normalizedValue: unknown
  confidence: number | null
  isEdited: boolean
  sourcePage: number | null
  sourceBbox: BoundingBox | null
  sourceFound: boolean
}

export interface CanonicalInput {
  documentId: string
  documentType: DocumentType
  schemaVersion: number | null
  sourceType: SourceType
  originalFilename: string
  checksum: string
  receivedAt: string
  approvedAt: string | null
  fields: CanonicalInputField[]
  warnings: Array<{ ruleId: string; fieldName: string | null; message: string }>
  /** Момент формирования: передаётся снаружи, чтобы результат был воспроизводим. */
  generatedAt: string
}

export function buildCanonicalDocument(input: CanonicalInput): CanonicalDocument {
  const fields: Record<string, CanonicalFieldValue> = {}
  let lineItems: LineItem[] | null = null

  for (const field of input.fields) {
    if (field.valueType === 'array') {
      // Позиции выносятся отдельным блоком: у них своя структура, и адаптеры
      // назначения работают с ними иначе, чем со скалярными полями.
      lineItems = Array.isArray(field.normalizedValue)
        ? (field.normalizedValue as LineItem[])
        : null
      continue
    }

    fields[field.name] = {
      value: field.normalizedValue ?? null,
      raw: field.rawValue,
      confidence: field.confidence,
      edited: field.isEdited,
      source:
        field.sourceFound && field.sourcePage !== null && field.sourceBbox !== null
          ? { page: field.sourcePage, bbox: field.sourceBbox }
          : null,
    }
  }

  return {
    formatVersion: CANONICAL_FORMAT_VERSION,
    documentId: input.documentId,
    documentType: input.documentType,
    schemaVersion: input.schemaVersion,
    source: {
      type: input.sourceType,
      originalFilename: input.originalFilename,
      checksum: input.checksum,
      receivedAt: input.receivedAt,
    },
    fields,
    lineItems,
    warnings: input.warnings,
    approvedAt: input.approvedAt,
    generatedAt: input.generatedAt,
  }
}

/**
 * Маппинг внутренних полей на поля назначения (ТЗ 6.8). Порядок колонок
 * значим: адаптеры вроде Google Sheets пишут строку по нему.
 */
export interface ExportColumn {
  /** Заголовок колонки в системе назначения. */
  column: string
  /** `field:<имя>` — значение поля, `meta:<путь>` — метаданные документа. */
  source: string
}

export type ExportMapping = ExportColumn[]

export type ExportCell = string | number | boolean | null

/** Строка для табличного назначения по маппингу. */
export function toRow(canonical: CanonicalDocument, mapping: ExportMapping): ExportCell[] {
  return mapping.map((column) => resolve(canonical, column.source))
}

export function toHeader(mapping: ExportMapping): string[] {
  return mapping.map((column) => column.column)
}

function resolve(canonical: CanonicalDocument, source: string): ExportCell {
  const [kind, path] = splitOnce(source, ':')

  if (kind === 'field') {
    const value = canonical.fields[path]?.value
    return toCell(value)
  }

  if (kind === 'meta') {
    switch (path) {
      case 'documentId':
        return canonical.documentId
      case 'documentType':
        return canonical.documentType
      case 'originalFilename':
        return canonical.source.originalFilename
      case 'checksum':
        return canonical.source.checksum
      case 'receivedAt':
        return canonical.source.receivedAt
      case 'approvedAt':
        return canonical.approvedAt
      case 'lineItemCount':
        return canonical.lineItems?.length ?? 0
      default:
        return null
    }
  }

  return null
}

function toCell(value: unknown): ExportCell {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  return JSON.stringify(value)
}

function splitOnce(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator)
  return index === -1 ? [text, ''] : [text.slice(0, index), text.slice(index + 1)]
}
