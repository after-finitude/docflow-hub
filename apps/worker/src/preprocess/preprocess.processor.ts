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
  startRun,
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

export interface PreprocessJob {
  documentId: string
  correlationId: string
}

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

    const [document] = await this.db
      .select({
        id: documents.id,
        storageKey: documents.storageKey,
        mimeType: documents.mimeType,
        originalFilename: documents.originalFilename,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)

    if (!document) {
      // Deletion while a job waited in the queue is not a processing error.
      this.logger.warn(`Document ${documentId} not found; skipping job`)
      return
    }

    const runId = await startRun(this.db, documentId, 'preprocess', correlationId)
    await this.updateStatus(documentId, 'processing', null, 'running')

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
      // A permanent file defect cannot be fixed by retrying. Do not throw, or
      // BullMQ would reread a known-bad file three times.
      await failRun(this.db, runId, result.code, result.reason)
      await this.db
        .update(documents)
        .set({ status: 'rejected', statusReason: result.reason, processedAt: new Date() })
        .where(eq(documents.id, documentId))

      await writeAudit(this.db, {
        correlationId,
        actorType: 'system',
        action: 'document.rejected',
        objectType: 'document',
        objectId: documentId,
        after: { code: result.code, reason: result.reason },
        result: 'success',
      })

      await this.updateStatus(documentId, 'rejected', result.reason, 'failed')
      this.logger.log(`Document ${documentId} rejected: ${result.code}`)
      return
    }

    try {
      const key = thumbnailKeyFor(document.storageKey)
      await this.storage.put(key, result.thumbnail, 'image/png')

      await this.db
        .update(documents)
        .set({ thumbnailKey: key, pageCount: result.pageCount, statusReason: null })
        .where(eq(documents.id, documentId))

      await finishRun(this.db, runId)
      // Keep the document processing and pass it to the next stage.
      await this.ocrQueue.add('ocr', { documentId, correlationId })
      await this.updateStatus(documentId, 'processing', null, 'succeeded')
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
    const detail = error instanceof Error ? error.message : String(error)
    await failRun(this.db, runId, code, detail)

    const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1)
    if (attemptsLeft > 0) {
      this.logger.warn(`Document ${documentId}: ${code}, ${attemptsLeft} attempt(s) left`)
      return
    }

    // The job will not retry automatically; it moves to the dead-letter queue
    // for an operator to retry from the Execution Log (spec 6.10).
    await recordDeadLetter(this.db, {
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
    await this.db
      .update(documents)
      .set({ status: 'failed', statusReason: reason })
      .where(eq(documents.id, documentId))
    await this.updateStatus(documentId, 'failed', reason, 'failed')
    this.logger.error(`Document ${documentId}: ${code} — attempts exhausted`)
  }

  private async updateStatus(
    documentId: string,
    status: DocumentStatus,
    statusReason: string | null,
    state: WorkflowState,
  ): Promise<void> {
    if (status === 'processing') {
      await this.db
        .update(documents)
        .set({ status, statusReason })
        .where(eq(documents.id, documentId))
    }
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
