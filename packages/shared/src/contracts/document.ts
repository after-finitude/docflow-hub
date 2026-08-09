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

/** Ограничения приёма файлов, ТЗ 6.1. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024
export const ACCEPTED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number]

/** Этапы, отображаемые в прогрессе обработки (ТЗ 5.1). */
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
  sizeBytes: number
  sourceType: SourceType
  documentType: DocumentType | null
  typeConfidence: number | null
  status: DocumentStatus
  /** Причина отклонения или отказа — показывается оператору как есть. */
  statusReason: string | null
  /** Минимальная уверенность среди критичных полей, ТЗ 5.1. */
  minCriticalConfidence: number | null
  blockingIssues: number
  warningIssues: number
  hasThumbnail: boolean
  duplicateOfId: string | null
  /** Номер версии по пути источника; актуальна последняя (ТЗ 6.9). */
  versionNumber: number
  /** false — вытеснен новой версией или удалён в источнике. */
  isActive: boolean
  /** Последний этап обработки — для индикатора прогресса. */
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

/** Фильтры очереди, ТЗ 5.1. */
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
  checksum: string
  sourcePath: string | null
  processedAt: string | null
  pageCount: number | null
  /** Извлечённые поля (ТЗ §8: документ с полями и проблемами). */
  fields: FieldDto[]
  issues: IssueDto[]
  /** Пороги активной схемы: по ним UI красит и сортирует поля (ТЗ 5.2). */
  thresholds: SchemaThresholds | null
  /** Выгрузки документа: статус и возможность повтора (ТЗ 6.8). */
  exports: ExportDto[]
  /**
   * Доступность Approve. Обновляется в ответе на правку поля, чтобы кнопка
   * не требовала отдельного запроса (ТЗ 5.2).
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
 * Событие живого обновления очереди (ТЗ 5.1: SSE, при недоступности — polling).
 * Публикуется воркером в Redis, раздаётся API через SSE.
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
  ingestion: 'Приём',
  preprocess: 'Подготовка',
  ocr: 'OCR',
  classification: 'Классификация',
  extraction: 'Извлечение',
  validation: 'Проверка',
  export: 'Экспорт',
}

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  received: 'Получен',
  processing: 'Обработка',
  needs_review: 'На проверке',
  approved: 'Подтверждён',
  exported: 'Выгружен',
  failed: 'Ошибка',
  rejected: 'Отклонён',
}

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  invoice: 'Инвойс',
  bank_statement: 'Банковская выписка',
  tax_letter: 'Налоговое письмо',
  contract: 'Договор',
  unknown: 'Не определён',
}

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  upload: 'Загрузка',
  email: 'Почта',
  drive: 'Диск',
}

export const WORKFLOW_STATE_LABELS: Record<WorkflowState, string> = {
  pending: 'ожидает',
  running: 'выполняется',
  succeeded: 'выполнен',
  failed: 'ошибка',
}

export const ALL_WORKFLOW_STEPS = WORKFLOW_STEPS
export const ALL_WORKFLOW_STATES = WORKFLOW_STATES
