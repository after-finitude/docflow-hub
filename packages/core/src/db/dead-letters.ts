import type { WorkflowStep } from '@docflow/shared'
import type { Database } from './db.module'
import { deadLetters } from './schema'

/**
 * Dead-letter queue (spec 6.10, second stage). Create a record only after all
 * attempts are exhausted; intermediate failures will retry automatically.
 */
export interface DeadLetterInput {
  documentId: string
  runId: string | null
  step: WorkflowStep
  queue: string
  jobId?: string | null
  /** Job input used by the expanded Execution Log row. */
  payload?: unknown
  errorCode: string
  error: unknown
  attempts: number
}

export async function recordDeadLetter(db: Database, input: DeadLetterInput): Promise<void> {
  const error = input.error
  await db.insert(deadLetters).values({
    documentId: input.documentId,
    runId: input.runId,
    step: input.step,
    queue: input.queue,
    jobId: input.jobId ?? null,
    payload: input.payload ?? null,
    errorCode: input.errorCode,
    errorMessage: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
    attempts: input.attempts,
  })
}
