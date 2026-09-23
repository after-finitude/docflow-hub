import {
  DB,
  DocumentEventsService,
  ENV,
  PIPELINE_WORKER_OPTIONS,
  QUEUE,
  StorageService,
  documents,
  finishRun,
  pages,
  queueConcurrency,
  beginPipelineRun,
  lockPipelineDocument,
  type PipelineJob,
  type PipelineStage,
  handlePipelineFailure,
  publishStageEvent,
  validationIssues,
  writeAudit,
  externalCallRecorder,
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
import { Queue, type Job } from 'bullmq'
import { and, eq, isNull } from 'drizzle-orm'
import { OCR_PROVIDER, type OcrProvider } from './ocr-provider'

export type OcrJob = PipelineJob

const STAGE: PipelineStage = {
  step: 'ocr',
  queue: QUEUE.OCR,
  errorCode: 'ocr_failed',
  failureReason: 'Document recognition failed. Processing can be retried manually',
}

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
      const result = await this.provider.recognize(
        buffer,
        document.mimeType,
        this.provider.external
          ? externalCallRecorder(this.db, {
              documentId,
              correlationId,
              runId,
              provider: this.provider.name,
            })
          : undefined,
      )

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
    recognized: {
      pageNumber: number
      text: string
      confidence: number | null
      blank?: boolean
      requiresReview?: boolean
    }[],
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
          requiresReview: page.requiresReview,
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

  private publish(documentId: string, status: DocumentStatus, state: WorkflowState) {
    return publishStageEvent(this.events, STAGE.step, documentId, status, state)
  }
}
