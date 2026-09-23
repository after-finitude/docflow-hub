/**
 * Domain enums, kept in sync with PostgreSQL enums in packages/core/src/db/schema.ts.
 */

export const USER_ROLES = ['operator', 'admin'] as const
export type UserRole = (typeof USER_ROLES)[number]

/** Document statuses, spec 5.1. */
export const DOCUMENT_STATUSES = [
  'received',
  'processing',
  'needs_review',
  'approved',
  'exported',
  'failed',
  'rejected',
] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/** Four required document types plus Unknown, spec 6.3. */
export const DOCUMENT_TYPES = [
  'invoice',
  'bank_statement',
  'tax_letter',
  'contract',
  'unknown',
] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/** Types classification can assign; unknown is fallback only. */
export const CLASSIFIABLE_DOCUMENT_TYPES = [
  'invoice',
  'bank_statement',
  'tax_letter',
  'contract',
] as const
export type ClassifiableDocumentType = (typeof CLASSIFIABLE_DOCUMENT_TYPES)[number]

export const SOURCE_TYPES = ['upload', 'email', 'drive'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/** Document-schema field types, spec 6.4. */
export const VALUE_TYPES = [
  'string',
  'number',
  'date',
  'currency',
  'enum',
  'boolean',
  'array',
] as const
export type ValueType = (typeof VALUE_TYPES)[number]

/** Validation severity levels, spec 6.6. */
export const ISSUE_SEVERITIES = ['info', 'warning', 'blocking'] as const
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number]

/** Processing stages, spec 5.3. */
export const WORKFLOW_STEPS = [
  'ingestion',
  'preprocess',
  'ocr',
  'classification',
  'extraction',
  'validation',
  'export',
] as const
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number]

export const WORKFLOW_STATES = ['pending', 'running', 'succeeded', 'failed'] as const
export type WorkflowState = (typeof WORKFLOW_STATES)[number]

export const EXPORT_STATUSES = ['pending', 'succeeded', 'failed'] as const
export type ExportStatus = (typeof EXPORT_STATUSES)[number]

export const ACTOR_TYPES = ['user', 'system'] as const
export type ActorType = (typeof ACTOR_TYPES)[number]

/** Required destination adapters (spec 6.8). */
export const EXPORT_DESTINATIONS = ['file_json', 'google_sheets'] as const
export type ExportDestination = (typeof EXPORT_DESTINATIONS)[number]

/** Listed rejection reasons; the request adds a free-form comment (spec 5.2). */
export const REJECT_REASONS = [
  'poor_scan_quality',
  'wrong_document_type',
  'duplicate',
  'incomplete_document',
  'not_our_document',
  'other',
] as const
export type RejectReason = (typeof REJECT_REASONS)[number]

/** Field-list filters in the right column (spec 5.2). */
export const FIELD_FILTERS = ['all', 'missing', 'low_confidence', 'invalid'] as const
export type FieldFilter = (typeof FIELD_FILTERS)[number]
