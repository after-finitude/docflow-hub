import type { DocumentStatus, WorkflowState, WorkflowStep } from '@docflow/shared'
import type { Logger } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import { eq } from 'drizzle-orm'
import { recordDeadLetter } from '../db/dead-letters'
import type { Database } from '../db/db.module'
import { documents } from '../db/schema'
import { failRun, lockPipelineDocument, type PipelineJob } from '../db/workflow'
import type { DocumentEventsService } from '../events/document-events.service'
import type { QueueName } from './queues'

export interface PipelineStage {
  step: WorkflowStep
  queue: QueueName
  errorCode: string
  /** Status reason shown once automatic retries are over. */
  failureReason: string
}

export interface PipelineContext {
  db: Database
  events: DocumentEventsService
  logger: Logger
}

export async function publishStageEvent(
  events: DocumentEventsService,
  step: WorkflowStep,
  documentId: string,
  status: DocumentStatus,
  state: WorkflowState,
): Promise<void> {
  await events.publish({
    type: 'document',
    documentId,
    status,
    step,
    state,
    at: new Date().toISOString(),
  })
}

/**
 * Record a failed attempt; the caller rethrows so BullMQ applies its retry policy.
 * The document becomes `failed`, with a dead letter, only once no retry follows —
 * attempts exhausted or an UnrecoverableError. Marking it on every attempt would
 * make the queue flash an error on each retry.
 */
export async function handlePipelineFailure(
  { db, events, logger }: PipelineContext,
  stage: PipelineStage,
  job: Job<PipelineJob>,
  runId: string,
  error: unknown,
): Promise<void> {
  const { documentId } = job.data
  await db.transaction(async (tx) => {
    if (!(await lockPipelineDocument(tx, job.data, stage.step))) return
    const detail = error instanceof Error ? error.message : String(error)
    await failRun(tx, runId, stage.errorCode, detail)

    const unrecoverable = error instanceof UnrecoverableError
    const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1)
    if (!unrecoverable && attemptsLeft > 0) {
      logger.warn(
        `Document ${documentId}: ${stage.step} failed (${stage.errorCode}); ${attemptsLeft} attempt(s) left`,
      )
      return
    }

    // The job will not retry automatically; it moves to the dead-letter queue
    // for an operator to retry from the Execution Log (spec 6.10).
    await recordDeadLetter(tx, {
      documentId,
      runId,
      step: stage.step,
      queue: stage.queue,
      jobId: job.id ?? null,
      payload: job.data,
      errorCode: stage.errorCode,
      error,
      attempts: job.attemptsMade + 1,
    })

    await tx
      .update(documents)
      .set({ status: 'failed', statusReason: stage.failureReason, processingStep: null })
      .where(eq(documents.id, documentId))
    await publishStageEvent(events, stage.step, documentId, 'failed', 'failed')
    logger.error(
      `Document ${documentId}: ${stage.step} failed (${stage.errorCode}) — ${unrecoverable ? 'unrecoverable error' : 'attempts exhausted'}: ${detail}`,
    )
  })
}
