import type { DocumentType, SourceType } from '../enums'
import type { BoundingBox } from '../contracts/ocr'
import type { LineItem } from '../contracts/review'

/**
 * Canonical JSON (spec 6.8): one destination-independent result including
 * operator edits and the schema version used for extraction.
 */

export const CANONICAL_FORMAT_VERSION = 1

export interface CanonicalFieldValue {
  /** Normalized value sent to external systems. */
  value: unknown
  /** Verbatim document value, null when missing or entered manually. */
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
  /** Unresolved warnings that did not block approval but remain useful context. */
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
  /** Generation time supplied externally for reproducibility. */
  generatedAt: string
}

export function buildCanonicalDocument(input: CanonicalInput): CanonicalDocument {
  const fields: Record<string, CanonicalFieldValue> = {}
  let lineItems: LineItem[] | null = null

  for (const field of input.fields) {
    if (field.valueType === 'array' && field.name !== 'transactions') {
      // Keep line items separate because destinations handle their structure
      // differently from scalar fields.
      lineItems = Array.isArray(field.normalizedValue)
        ? (field.normalizedValue as LineItem[])
        : null
      continue
    }

    // Statement transactions stay in fields, preserving edits and table source metadata.
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
 * Internal-to-destination field mapping (spec 6.8). Column order determines
 * rows written by adapters such as Google Sheets.
 */
export interface ExportColumn {
  /** Destination column header. */
  column: string
  /** `field:<name>` for a field value, `meta:<path>` for document metadata. */
  source: string
}

export type ExportMapping = ExportColumn[]

export type ExportCell = string | number | boolean | null

/** Mapped row for a tabular destination. */
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
