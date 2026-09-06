import { z } from 'zod'
import {
  CLASSIFIABLE_DOCUMENT_TYPES,
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  SOURCE_TYPES,
  WORKFLOW_STATES,
  WORKFLOW_STEPS,
  type DocumentStatus,
  type DocumentType,
  type SourceType,
  type WorkflowState,
  type WorkflowStep,
} from '../enums'
import type { ExportDto } from './export'
import type { FieldDto, IssueDto } from './field'
import type { SchemaThresholds } from './schema'

/** File ingest limits, spec 6.1. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024
export const ACCEPTED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number]

export const oversizedUploadRequestSchema = z
  .object({
    filename: z.string().trim().min(1).max(1024),
    mimeType: z.enum(ACCEPTED_MIME_TYPES),
    sizeBytes: z.number().int().safe().gt(UPLOAD_MAX_BYTES),
  })
  .strict()
export type OversizedUploadRequest = z.infer<typeof oversizedUploadRequestSchema>

/** Stages shown in processing progress (spec 5.1). */
export const PIPELINE_UI_STEPS: WorkflowStep[] = [
  'preprocess',
  'ocr',
  'classification',
  'extraction',
  'validation',
]

export interface DocumentListItem {
  id: string
  originalFilename: string
  mimeType: string
  sizeBytes: number | null
  hasOriginal: boolean
  sourceType: SourceType
  documentType: DocumentType | null
  typeConfidence: number | null
  status: DocumentStatus
  /** Rejection or failure reason shown verbatim to the operator. */
  statusReason: string | null
  /** Minimum confidence among critical fields, spec 5.1. */
  minCriticalConfidence: number | null
  blockingIssues: number
  warningIssues: number
  hasThumbnail: boolean
  duplicateOfId: string | null
  /** Version number by source path; the latest is active (spec 6.9). */
  versionNumber: number
  /** Previous version of the same document, if any. */
  previousVersionId: string | null
  /** false when replaced by a newer version or removed from the source. */
  isActive: boolean
  /** Latest processing stage for the progress indicator. */
  currentStep: WorkflowStep | null
  currentStepState: WorkflowState | null
  receivedAt: string
}

export interface DocumentListPage {
  items: DocumentListItem[]
  total: number
  page: number
  pageSize: number
}

/** Queue filters, spec 5.1. */
export const documentListQuerySchema = z.object({
  status: z
    .union([z.enum(DOCUMENT_STATUSES), z.array(z.enum(DOCUMENT_STATUSES))])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  type: z
    .union([z.enum(DOCUMENT_TYPES), z.array(z.enum(DOCUMENT_TYPES))])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  source: z
    .union([z.enum(SOURCE_TYPES), z.array(z.enum(SOURCE_TYPES))])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  receivedFrom: z.iso.datetime({ offset: true }).optional(),
  receivedTo: z.iso.datetime({ offset: true }).optional(),
  hasBlocking: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>

export interface DocumentDetail extends DocumentListItem {
  schemaVersionId: string | null
  schemaVersion: number | null
  checksum: string | null
  sourcePath: string | null
  processedAt: string | null
  pageCount: number | null
  /** Extracted fields (spec §8: document with fields and issues). */
  fields: FieldDto[]
  issues: IssueDto[]
  /** Active-schema thresholds used by the UI to color and sort fields (spec 5.2). */
  thresholds: SchemaThresholds | null
  /** Document exports with status and retry availability (spec 6.8). */
  exports: ExportDto[]
  /**
   * Approval availability, updated after field edits so the button needs no
   * separate request (spec 5.2).
   */
  canApprove: boolean
}

export const changeTypeRequestSchema = z.object({
  type: z.enum(CLASSIFIABLE_DOCUMENT_TYPES),
})
export type ChangeTypeRequest = z.infer<typeof changeTypeRequestSchema>

export interface SignedFileLink {
  url: string
  expiresInSeconds: number
}

/**
 * Live queue update event (spec 5.1: SSE with polling fallback), published by
 * workers through Redis and served by the API.
 */
export interface DocumentEvent {
  type: 'document'
  documentId: string
  status: DocumentStatus
  step: WorkflowStep | null
  state: WorkflowState | null
  at: string
}

export interface HeartbeatEvent {
  type: 'heartbeat'
  at: string
}

export type StreamEvent = DocumentEvent | HeartbeatEvent

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
