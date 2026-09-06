import {
  DB,
  DocumentEventsService,
  ENV,
  PIPELINE_WORKER_OPTIONS,
  QUEUE,
  StorageService,
  documents,
  failRun,
  finishRun,
  queueConcurrency,
  recordDeadLetter,
  beginPipelineRun,
  lockPipelineDocument,
  type PipelineJob,
  thumbnailKeyFor,
  writeAudit,
  type Database,
  type Env,
} from '@docflow/core'
import type { DocumentStatus, WorkflowState } from '@docflow/shared'
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnModuleInit } from '@nestjs/common'
import { Queue, type Job } from 'bullmq'
import { eq } from 'drizzle-orm'
import { inspect } from './document-inspector'

export type PreprocessJob = PipelineJob

/**
 * First pipeline stage: inspect the file, create a thumbnail, and count pages.
 * Successfully prepared documents move to the OCR queue.
 */
@Processor(QUEUE.PREPROCESS, { ...PIPELINE_WORKER_OPTIONS })
export class PreprocessProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(PreprocessProcessor.name)

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly storage: StorageService,
    private readonly events: DocumentEventsService,
    @InjectQueue(QUEUE.OCR) private readonly ocrQueue: Queue,
  ) {
    super()
  }

  onModuleInit(): void {
    // Read concurrency from validated configuration rather than a decorator
    // constant because decorators run before the container initializes.
    this.worker.concurrency = queueConcurrency(this.env, QUEUE.PREPROCESS)
  }

  async process(job: Job<PreprocessJob>): Promise<void> {
    const { documentId, correlationId } = job.data

    const started = await beginPipelineRun(this.db, job.data, 'preprocess')
    if (!started) return
    const { document, runId } = started
    await this.publish(documentId, 'processing', 'running')

    let buffer: Buffer
    try {
      buffer = await this.storage.getBuffer(document.storageKey)
    } catch (error) {
      // Storage unavailability is transient, so the job should retry.
      await this.handleTransientFailure(job, documentId, runId, 'storage_unavailable', error)
      throw error
    }

    const result = await inspect(buffer, document.mimeType)

    if (!result.ok) {
      await this.db.transaction(async (db) => {
        if (!(await lockPipelineDocument(db, job.data, 'preprocess'))) return
        // A permanent file defect cannot be fixed by retrying. Do not throw, or
        // BullMQ would reread a known-bad file three times.
        await failRun(db, runId, result.code, result.reason)
        await db
          .update(documents)
          .set({
            status: 'rejected',
            processingStep: null,
            statusReason: result.reason,
            processedAt: new Date(),
          })
          .where(eq(documents.id, documentId))

        await writeAudit(db, {
          correlationId,
          actorType: 'system',
          action: 'document.rejected',
          objectType: 'document',
          objectId: documentId,
          after: { code: result.code, reason: result.reason },
          result: 'success',
        })

        await this.publish(documentId, 'rejected', 'failed')
        this.logger.log(`Document ${documentId} rejected: ${result.code}`)
      })
      return
    }

    try {
      const key = thumbnailKeyFor(document.storageKey)
      await this.storage.put(key, result.thumbnail, 'image/png')

      await this.db.transaction(async (db) => {
        if (!(await lockPipelineDocument(db, job.data, 'preprocess'))) return
        await db
          .update(documents)
          .set({
            thumbnailKey: key,
            pageCount: result.pageCount,
            processingStep: 'ocr',
            statusReason: null,
          })
          .where(eq(documents.id, documentId))

        await finishRun(db, runId)
        // Keep the document processing and pass it to the next stage.
        await this.ocrQueue.add('ocr', job.data)
        await this.publish(documentId, 'processing', 'succeeded')
      })
      this.logger.log(`Document ${documentId} prepared, pages: ${result.pageCount}`)
    } catch (error) {
      await this.handleTransientFailure(job, documentId, runId, 'thumbnail_failed', error)
      throw error
    }
  }

  /**
   * Mark Failed only after attempts are exhausted. Until then the document
   * remains processing so the queue does not flash an error on every retry.
   */
  private async handleTransientFailure(
    job: Job<PreprocessJob>,
    documentId: string,
    runId: string,
    code: string,
    error: unknown,
  ): Promise<void> {
    await this.db.transaction(async (db) => {
      if (!(await lockPipelineDocument(db, job.data, 'preprocess'))) return
      const detail = error instanceof Error ? error.message : String(error)
      await failRun(db, runId, code, detail)

      const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1)
      if (attemptsLeft > 0) {
        this.logger.warn(`Document ${documentId}: ${code}, ${attemptsLeft} attempt(s) left`)
        return
      }

      // The job will not retry automatically; it moves to the dead-letter queue
      // for an operator to retry from the Execution Log (spec 6.10).
      await recordDeadLetter(db, {
        documentId,
        runId,
        step: 'preprocess',
        queue: QUEUE.PREPROCESS,
        jobId: job.id ?? null,
        payload: job.data,
        errorCode: code,
        error,
        attempts: job.attemptsMade + 1,
      })

      const reason = 'Document preparation failed. Processing can be retried manually'
      await db
        .update(documents)
        .set({ status: 'failed', statusReason: reason, processingStep: null })
        .where(eq(documents.id, documentId))
      await this.publish(documentId, 'failed', 'failed')
      this.logger.error(`Document ${documentId}: ${code} — attempts exhausted`)
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
      step: 'preprocess',
      state,
      at: new Date().toISOString(),
    })
  }
}
