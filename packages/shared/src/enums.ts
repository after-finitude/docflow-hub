/**
 * Доменные перечисления. Единственный источник правды: значения совпадают
 * с pg-энумами в схеме БД (packages/core/src/db/schema.ts).
 */

export const USER_ROLES = ['operator', 'admin'] as const
export type UserRole = (typeof USER_ROLES)[number]

/** Статусы документа, ТЗ 5.1. */
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

/** Четыре типа документов обязательного объёма + Unknown, ТЗ 6.3. */
export const DOCUMENT_TYPES = [
  'invoice',
  'bank_statement',
  'tax_letter',
  'contract',
  'unknown',
] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/** Типы, которые может назначить классификация; unknown — только фолбэк. */
export const CLASSIFIABLE_DOCUMENT_TYPES = [
  'invoice',
  'bank_statement',
  'tax_letter',
  'contract',
] as const
export type ClassifiableDocumentType = (typeof CLASSIFIABLE_DOCUMENT_TYPES)[number]

export const SOURCE_TYPES = ['upload', 'email', 'drive'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/** Типы полей схемы документа, ТЗ 6.4. */
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

/** Уровни серьёзности проверок, ТЗ 6.6. */
export const ISSUE_SEVERITIES = ['info', 'warning', 'blocking'] as const
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number]

/** Этапы обработки, ТЗ 5.3. */
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
