import type { BoundingBox } from './ocr'
import type { IssueSeverity, ValueType } from '../enums'

/** Document field in API responses (spec 5.2, §8). */
export interface FieldDto {
  name: string
  label: string
  valueType: ValueType
  rawValue: string | null
  normalizedValue: unknown
  confidence: number | null
  confidenceReason: string | null
  sourcePage: number | null
  sourceBbox: BoundingBox | null
  sourceFound: boolean
  isCritical: boolean
  isRequired: boolean
  isEdited: boolean
}

/** Validation issue in API responses (spec 6.6). */
export interface IssueDto {
  id: string
  fieldName: string | null
  ruleId: string
  severity: IssueSeverity
  message: string
  expected: string | null
  actual: string | null
  resolvedAt: string | null
}
