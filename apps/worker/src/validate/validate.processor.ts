import {
  DB,
  DocumentEventsService,
  ENV,
  PIPELINE_WORKER_OPTIONS,
  QUEUE,
  ValidationRunnerService,
  documents,
  finishRun,
  queueConcurrency,
  beginPipelineRun,
  lockPipelineDocument,
  type PipelineJob,
  type PipelineStage,
  handlePipelineFailure,
  publishStageEvent,
  type Database,
  type Env,
} from '@docflow/core'
import type { DocumentStatus, WorkflowState } from '@docflow/shared'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnModuleInit } from '@nestjs/common'
import type { Job } from 'bullmq'
import { eq } from 'drizzle-orm'

export type ValidateJob = PipelineJob

const STAGE: PipelineStage = {
  step: 'validation',
  queue: QUEUE.VALIDATE,
  errorCode: 'validation_failed',
  failureReason: 'Document validation failed. Processing can be retried manually',
}

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
      await handlePipelineFailure(
        { db: this.db, events: this.events, logger: this.logger },
        STAGE,
        job,
        runId,
        error,
      )
      throw error
    }
  }

  private publish(documentId: string, status: DocumentStatus, state: WorkflowState) {
    return publishStageEvent(this.events, STAGE.step, documentId, status, state)
  }
}
