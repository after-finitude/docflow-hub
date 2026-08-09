import { z } from 'zod'
import {
  WORKFLOW_STEPS,
  type DocumentStatus,
  type WorkflowState,
  type WorkflowStep,
} from '../enums'

/** Журнал выполнения этапов, экран Execution Log (ТЗ 5.3). */

/**
 * Запись из dead-letter queue: задача, исчерпавшая попытки. Полный текст
 * ошибки и стек живут здесь, а не в workflow_runs, — в журнале выполнения
 * хранится код и краткое сообщение.
 */
export interface DeadLetterDto {
  id: string
  queue: string
  jobId: string | null
  /** Входные параметры этапа — раскрытие строки в Execution Log. */
  payload: unknown
  errorCode: string
  errorMessage: string
  stack: string | null
  attempts: number
  failedAt: string
  retriedAt: string | null
}

export interface RunListItem {
  id: string
  documentId: string
  documentFilename: string
  documentStatus: DocumentStatus
  step: WorkflowStep
  state: WorkflowState
  attempts: number
  /** Длительность этапа; null, пока этап не завершён. */
  durationMs: number | null
  errorCode: string | null
  errorDetail: string | null
  correlationId: string
  startedAt: string | null
  finishedAt: string | null
  deadLetter: DeadLetterDto | null
}

export interface RunListPage {
  items: RunListItem[]
  total: number
  page: number
  pageSize: number
}

/** Фильтры журнала: только ошибки, диапазон дат, тип этапа (ТЗ 5.3). */
export const runListQuerySchema = z.object({
  onlyErrors: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  step: z
    .union([z.enum(WORKFLOW_STEPS), z.array(z.enum(WORKFLOW_STEPS))])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

export type RunListQuery = z.infer<typeof runListQuerySchema>
