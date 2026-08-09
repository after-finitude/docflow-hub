import type { WorkflowStep } from '@docflow/shared'
import type { Database } from './db.module'
import { deadLetters } from './schema'

/**
 * Dead-letter queue (ТЗ 6.10, второй этап). Запись создаётся только когда
 * попытки исчерпаны: промежуточные отказы — это ещё не потерянная задача,
 * и складывать их в DLQ значило бы хоронить то, что повторится само.
 */
export interface DeadLetterInput {
  documentId: string
  runId: string | null
  step: WorkflowStep
  queue: string
  jobId?: string | null
  /** Вход задачи: по нему строится раскрытие строки в Execution Log. */
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
