import {
  WORKFLOW_STATES,
  WORKFLOW_STEPS,
  type DocumentStatus,
  type DocumentType,
  type ExportDestination,
  type FieldFilter,
  type RejectReason,
  type SourceType,
  type WorkflowState,
  type WorkflowStep,
} from './enums'

/**
 * Display labels and UI step lists. Kept free of zod so the browser entry
 * (`@docflow/shared/browser`) does not pull in the contract schemas.
 */

/** Stages shown in processing progress (spec 5.1). */
export const PIPELINE_UI_STEPS: WorkflowStep[] = [
  'preprocess',
  'ocr',
  'classification',
  'extraction',
  'validation',
]

export const WORKFLOW_STEP_LABELS: Record<WorkflowStep, string> = {
  ingestion: 'Ingest',
  preprocess: 'Preparation',
  ocr: 'OCR',
  classification: 'Classification',
  extraction: 'Extraction',
  validation: 'Validation',
  export: 'Export',
}

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  received: 'Received',
  processing: 'Processing',
  needs_review: 'Needs review',
  approved: 'Approved',
  exported: 'Exported',
  failed: 'Failed',
  rejected: 'Rejected',
}

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  invoice: 'Invoice',
  bank_statement: 'Bank statement',
  tax_letter: 'Tax letter',
  contract: 'Contract',
  unknown: 'Unknown',
}

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  upload: 'Upload',
  email: 'Email',
  drive: 'Drive',
}

export const WORKFLOW_STATE_LABELS: Record<WorkflowState, string> = {
  pending: 'pending',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
}

export const ALL_WORKFLOW_STEPS = WORKFLOW_STEPS
export const ALL_WORKFLOW_STATES = WORKFLOW_STATES

export const EXPORT_DESTINATION_LABELS: Record<ExportDestination, string> = {
  file_json: 'JSON file',
  google_sheets: 'Google Sheets',
}

export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  poor_scan_quality: 'Poor scan quality',
  wrong_document_type: 'Wrong document type',
  duplicate: 'Duplicate',
  incomplete_document: 'Incomplete document',
  not_our_document: 'Not our document',
  other: 'Other',
}

export const FIELD_FILTER_LABELS: Record<FieldFilter, string> = {
  all: 'All',
  missing: 'Missing',
  low_confidence: 'Low confidence',
  invalid: 'Validation errors',
}
