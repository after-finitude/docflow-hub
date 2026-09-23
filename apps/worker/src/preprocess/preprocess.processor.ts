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
  beginPipelineRun,
  lockPipelineDocument,
  type PipelineJob,
  type PipelineStage,
  handlePipelineFailure,
  publishStageEvent,
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

/** errorCode is per failure: storage_unavailable or thumbnail_failed. */
const STAGE: Omit<PipelineStage, 'errorCode'> = {
  step: 'preprocess',
  queue: QUEUE.PREPROCESS,
  failureReason: 'Document preparation failed. Processing can be retried manually',
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

    const started = await beginPipelineRun(this.db, job.data, 'preprocess')
    if (!started) return
    const { document, runId } = started
    await this.publish(documentId, 'processing', 'running')

    let buffer: Buffer
    try {
      buffer = await this.storage.getBuffer(document.storageKey)
    } catch (error) {
      // Storage unavailability is transient, so the job should retry.
      await handlePipelineFailure(
        { db: this.db, events: this.events, logger: this.logger },
        { ...STAGE, errorCode: 'storage_unavailable' },
        job,
        runId,
        error,
      )
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
      await handlePipelineFailure(
        { db: this.db, events: this.events, logger: this.logger },
        { ...STAGE, errorCode: 'thumbnail_failed' },
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
