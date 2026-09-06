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
  pages,
  queueConcurrency,
  recordDeadLetter,
  beginPipelineRun,
  lockPipelineDocument,
  type PipelineJob,
  validationIssues,
  writeAudit,
  type Database,
  type Env,
} from '@docflow/core'
import {
  OCR_QUALITY_RULE,
  assessOcrQuality,
  type DocumentStatus,
  type WorkflowState,
} from '@docflow/shared'
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnModuleInit } from '@nestjs/common'
import { Queue, UnrecoverableError, type Job } from 'bullmq'
import { and, eq, isNull } from 'drizzle-orm'
import { OCR_PROVIDER, type OcrProvider } from './ocr-provider'

export type OcrJob = PipelineJob

/**
 * Second pipeline stage: OCR and per-page text storage with block coordinates
 * (spec 6.2), followed by classification.
 */
@Processor(QUEUE.OCR, { ...PIPELINE_WORKER_OPTIONS })
export class OcrProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(OcrProcessor.name)

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(OCR_PROVIDER) private readonly provider: OcrProvider,
    private readonly storage: StorageService,
    private readonly events: DocumentEventsService,
    @InjectQueue(QUEUE.CLASSIFY) private readonly classifyQueue: Queue,
  ) {
    super()
  }

  onModuleInit(): void {
    this.worker.concurrency = queueConcurrency(this.env, QUEUE.OCR)
  }

  async process(job: Job<OcrJob>): Promise<void> {
    const { documentId, correlationId } = job.data

    const started = await beginPipelineRun(this.db, job.data, 'ocr')
    if (!started) return
    const { document, runId } = started
    await this.publish(documentId, 'processing', 'running')

    try {
      const buffer = await this.storage.getBuffer(document.storageKey)
      const result = await this.provider.recognize(buffer, document.mimeType)

      await this.db.transaction(async (db) => {
        if (!(await lockPipelineDocument(db, job.data, 'ocr'))) return
        // A rerun replaces all pages instead of accumulating rows.
        await db.delete(pages).where(eq(pages.documentId, documentId))
        if (result.pages.length > 0) {
          await db.insert(pages).values(
            result.pages.map((page) => ({
              documentId,
              pageNumber: page.pageNumber,
              ocrText: page.text,
              ocrConfidence: page.confidence,
              width: Math.round(page.width),
              height: Math.round(page.height),
              blocks: page.blocks,
            })),
          )
        }

        // Spec §11: record which pages were sent to an external provider.
        const sentPages = result.pages
          .filter((page) => page.sentToProvider)
          .map((p) => p.pageNumber)
        if (this.provider.external && sentPages.length > 0) {
          await writeAudit(db, {
            correlationId,
            actorType: 'system',
            action: 'document.ocr_external',
            objectType: 'document',
            objectId: documentId,
            after: {
              provider: this.provider.name,
              pages: sentPages,
              corrections: result.pages
                .filter((page) => page.sentToProvider)
                .map((page) => ({
                  pageNumber: page.pageNumber,
                  rotationDegrees: page.rotationDegrees ?? 0,
                  providerCalls: page.providerCalls ?? 1,
                })),
            },
            result: 'success',
          })
        }

        await db
          .update(documents)
          .set({ pageCount: result.pages.length, processingStep: 'classification' })
          .where(eq(documents.id, documentId))

        await this.syncQualityWarning(db, documentId, result.pages)

        await finishRun(db, runId)
        await this.classifyQueue.add('classify', job.data)
        await this.publish(documentId, 'processing', 'succeeded')
      })
      this.logger.log(
        `Document ${documentId}: OCR (${this.provider.name}) completed, ${result.pages.length} page(s)`,
      )
    } catch (error) {
      await this.handleFailure(job, documentId, runId, error)
      throw error
    }
  }

  /**
   * OCR quality warning (spec §10). Set it here because validation operates on
   * fields while scan quality belongs to pages. EXTERNAL_RULE_IDS preserves it
   * during field revalidation, and FORCE_REVIEW_RULE_IDS prevents poor scans
   * from passing automatically.
   */
  private async syncQualityWarning(
    db: Database,
    documentId: string,
    // Do not call this `pages`; that name is already used by the imported table.
    recognized: { pageNumber: number; text: string; confidence: number | null; blank?: boolean }[],
  ): Promise<void> {
    await db
      .delete(validationIssues)
      .where(
        and(
          eq(validationIssues.documentId, documentId),
          eq(validationIssues.ruleId, OCR_QUALITY_RULE),
          isNull(validationIssues.resolvedAt),
        ),
      )

    const issue = assessOcrQuality(
      recognized
        .filter((page) => !page.blank)
        .map((page) => ({
          pageNumber: page.pageNumber,
          confidence: page.confidence,
          textLength: page.text.trim().length,
        })),
    )
    if (!issue) return

    await db.insert(validationIssues).values({
      documentId,
      fieldName: null,
      ruleId: OCR_QUALITY_RULE,
      severity: 'warning',
      message: issue.message,
      expected: issue.expected,
      actual: issue.actual,
    })
    this.logger.warn(`Document ${documentId}: ${issue.actual}`)
  }

  /** Mark Failed only after attempts are exhausted or the error is unrecoverable. */
  private async handleFailure(
    job: Job<OcrJob>,
    documentId: string,
    runId: string,
    error: unknown,
  ): Promise<void> {
    await this.db.transaction(async (db) => {
      if (!(await lockPipelineDocument(db, job.data, 'ocr'))) return
      const detail = error instanceof Error ? error.message : String(error)
      await failRun(db, runId, 'ocr_failed', detail)

      const unrecoverable = error instanceof UnrecoverableError
      const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1)
      if (!unrecoverable && attemptsLeft > 0) {
        this.logger.warn(`Document ${documentId}: OCR failed; ${attemptsLeft} attempt(s) left`)
        return
      }

      // The job will not retry automatically; it moves to the dead-letter queue
      // for an operator to retry from the Execution Log (spec 6.10).
      await recordDeadLetter(db, {
        documentId,
        runId,
        step: 'ocr',
        queue: QUEUE.OCR,
        jobId: job.id ?? null,
        payload: job.data,
        errorCode: 'ocr_failed',
        error,
        attempts: job.attemptsMade + 1,
      })

      const reason = 'Document recognition failed. Processing can be retried manually'
      await db
        .update(documents)
        .set({ status: 'failed', statusReason: reason, processingStep: null })
        .where(eq(documents.id, documentId))
      await this.publish(documentId, 'failed', 'failed')
      this.logger.error(
        `Document ${documentId}: OCR — ${unrecoverable ? 'unrecoverable error' : 'attempts exhausted'}: ${detail}`,
      )
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
      step: 'ocr',
      state,
      at: new Date().toISOString(),
    })
  }
}
