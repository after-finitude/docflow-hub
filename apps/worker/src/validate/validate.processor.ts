import {
  DB,
  DocumentEventsService,
  ENV,
  PIPELINE_WORKER_OPTIONS,
  QUEUE,
  ValidationRunnerService,
  documents,
  failRun,
  finishRun,
  queueConcurrency,
  recordDeadLetter,
  beginPipelineRun,
  lockPipelineDocument,
  type PipelineJob,
  type Database,
  type Env,
} from '@docflow/core'
import type { DocumentStatus, WorkflowState } from '@docflow/shared'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnModuleInit } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import { eq } from 'drizzle-orm'

export type ValidateJob = PipelineJob

/**
 * Final automatic stage: validation, confidence recalculation, and routing
 * (spec 6.6, 6.7). ValidationRunnerService also runs the same logic
 * synchronously after an operator edits a field.
 */
@Processor(QUEUE.VALIDATE, { ...PIPELINE_WORKER_OPTIONS })
export class ValidateProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ValidateProcessor.name)

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly runner: ValidationRunnerService,
    private readonly events: DocumentEventsService,
  ) {
    super()
  }

  onModuleInit(): void {
    this.worker.concurrency = queueConcurrency(this.env, QUEUE.VALIDATE)
  }

  async process(job: Job<ValidateJob>): Promise<void> {
    const { documentId, correlationId } = job.data

    const started = await beginPipelineRun(this.db, job.data, 'validation')
    if (!started) return
    const { runId } = started
    await this.publish(documentId, 'processing', 'running')

    try {
      await this.db.transaction(async (db) => {
        if (!(await lockPipelineDocument(db, job.data, 'validation'))) return
        const outcome = await this.runner.runInTransaction(db, documentId, {
          correlationId,
          actorType: 'system',
        })
        await db.update(documents).set({ processingStep: null }).where(eq(documents.id, documentId))
        await finishRun(db, runId)
        await this.publish(documentId, outcome.status, 'succeeded')
      })
    } catch (error) {
      await this.handleFailure(job, documentId, runId, error)
      throw error
    }
  }

  private async handleFailure(
    job: Job<ValidateJob>,
    documentId: string,
    runId: string,
    error: unknown,
  ): Promise<void> {
    await this.db.transaction(async (db) => {
      if (!(await lockPipelineDocument(db, job.data, 'validation'))) return
      const detail = error instanceof Error ? error.message : String(error)
      await failRun(db, runId, 'validation_failed', detail)

      const unrecoverable = error instanceof UnrecoverableError
      const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1)
      if (!unrecoverable && attemptsLeft > 0) {
        this.logger.warn(
          `Document ${documentId}: validation failed; ${attemptsLeft} attempt(s) left`,
        )
        return
      }

      // The job will not retry automatically; it moves to the dead-letter queue
      // for an operator to retry from the Execution Log (spec 6.10).
      await recordDeadLetter(db, {
        documentId,
        runId,
        step: 'validation',
        queue: QUEUE.VALIDATE,
        jobId: job.id ?? null,
        payload: job.data,
        errorCode: 'validation_failed',
        error,
        attempts: job.attemptsMade + 1,
      })

      const reason = 'Document validation failed. Processing can be retried manually'
      await db
        .update(documents)
        .set({ status: 'failed', statusReason: reason, processingStep: null })
        .where(eq(documents.id, documentId))
      await this.publish(documentId, 'failed', 'failed')
      this.logger.error(`Document ${documentId}: validation — ${detail}`)
    })
  }

  private async publish(
    documentId: string,
    status: DocumentStatus,
    state: WorkflowState,
  ): Promise<void> {
    await this.events.publish({
      type: 'document',
      documentId,
      status,
      step: 'validation',
      state,
      at: new Date().toISOString(),
    })
  }
}
