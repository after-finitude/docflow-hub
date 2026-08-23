import { z } from 'zod'
import {
  WORKFLOW_STEPS,
  type DocumentStatus,
  type WorkflowState,
  type WorkflowStep,
} from '../enums'

/** Stage execution history for the Execution Log screen (spec 5.3). */

/**
 * Dead-letter queue entry for an exhausted job. Full error text and stack live
 * here; workflow_runs stores only the code and summary.
 */
export interface DeadLetterDto {
  id: string
  queue: string
  jobId: string | null
  /** Stage input shown in the expanded Execution Log row. */
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
  /** Stage duration, or null until completion. */
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

/** Log filters for errors, date range, and stage type (spec 5.3). */
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
