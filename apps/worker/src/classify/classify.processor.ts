import {
  DB,
  DocumentEventsService,
  ENV,
  PIPELINE_WORKER_OPTIONS,
  QUEUE,
  documents,
  failRun,
  finishRun,
  getActiveSchema,
  pages,
  queueConcurrency,
  recordDeadLetter,
  startRun,
  validationIssues,
  writeAudit,
  type Database,
  type Env,
} from '@docflow/core'
import type { DocumentStatus, WorkflowState } from '@docflow/shared'
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnModuleInit } from '@nestjs/common'
import { Queue, UnrecoverableError, type Job } from 'bullmq'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { LLM_PROVIDER, LlmInvalidResponseError, type LlmProvider } from '../llm/llm-provider'

export interface ClassifyJob {
  documentId: string
  correlationId: string
}

const MULTI_DOCUMENT_RULE = 'multi_document_suspected'

/**
 * Classify from OCR text on the first two pages (spec 6.3). Use the predicted
 * type's active-schema threshold; below it, mark the document unknown and send
 * it for manual type selection.
 */
@Processor(QUEUE.CLASSIFY, { ...PIPELINE_WORKER_OPTIONS })
export class ClassifyProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ClassifyProcessor.name)

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly events: DocumentEventsService,
    @InjectQueue(QUEUE.EXTRACT) private readonly extractQueue: Queue,
  ) {
    super()
  }

  onModuleInit(): void {
    this.worker.concurrency = queueConcurrency(this.env, QUEUE.CLASSIFY)
  }

  async process(job: Job<ClassifyJob>): Promise<void> {
    const { documentId, correlationId } = job.data

    const [document] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)
    if (!document) {
      this.logger.warn(`Document ${documentId} not found; skipping job`)
      return
    }

    const runId = await startRun(this.db, documentId, 'classification', correlationId)
    await this.publish(documentId, 'processing', 'running')

    try {
      const firstPages = await this.db
        .select({ page: pages.pageNumber, text: pages.ocrText })
        .from(pages)
        .where(eq(pages.documentId, documentId))
        .orderBy(asc(pages.pageNumber))
        .limit(2)

      const pagesText = firstPages.map((row) => ({ page: row.page, text: row.text ?? '' }))
      const hasText = pagesText.some((row) => row.text.trim().length > 0)

      if (!hasText) {
        // Without text there is nothing to classify; require manual type selection.
        await this.db
          .update(documents)
          .set({
            documentType: 'unknown',
            typeConfidence: 0,
            status: 'needs_review',
            statusReason: 'No text was recognized; select the type manually',
            processedAt: new Date(),
          })
          .where(eq(documents.id, documentId))
        await finishRun(this.db, runId)
        await this.publish(documentId, 'needs_review', 'succeeded')
        return
      }

      const result = await this.llm.classify({ pagesText })

      if (this.llm.external) {
        // Spec §11: record which pages were sent to an external provider.
        await writeAudit(this.db, {
          correlationId,
          actorType: 'system',
          action: 'document.llm_external',
          objectType: 'document',
          objectId: documentId,
          after: {
            provider: this.llm.name,
            purpose: 'classification',
            pages: pagesText.map((p) => p.page),
          },
          result: 'success',
        })
      }

      // The threshold is configured separately for each type (spec 6.3).
      let resolvedType: typeof result.document_type | 'unknown' = 'unknown'
      if (result.document_type) {
        const schema = await getActiveSchema(this.db, result.document_type)
        if (schema && result.confidence >= schema.thresholds.autoClassify) {
          resolvedType = result.document_type
        }
      }

      await this.syncMultiDocumentWarning(documentId, result.multi_document_suspected)

      await this.db
        .update(documents)
        .set({ documentType: resolvedType, typeConfidence: result.confidence })
        .where(eq(documents.id, documentId))

      await finishRun(this.db, runId)

      if (resolvedType === 'unknown') {
        // Unknown documents are not extracted or exported; select the type manually.
        await this.db
          .update(documents)
          .set({
            status: 'needs_review',
            statusReason: 'Document type is unknown; select it manually',
            processedAt: new Date(),
          })
          .where(eq(documents.id, documentId))
        await this.publish(documentId, 'needs_review', 'succeeded')
        this.logger.log(`Document ${documentId}: type unknown (confidence ${result.confidence})`)
        return
      }

      await this.extractQueue.add('extract', { documentId, correlationId })
      await this.publish(documentId, 'processing', 'succeeded')
      this.logger.log(`Document ${documentId}: type ${resolvedType} (${result.confidence})`)
    } catch (error) {
      if (error instanceof LlmInvalidResponseError) {
        // Manual review without data loss (spec 6.4): OCR pages remain available
        // so an operator can select a type and restart processing.
        await failRun(this.db, runId, 'llm_invalid_response', error.message)
        await this.db
          .update(documents)
          .set({
            documentType: 'unknown',
            status: 'needs_review',
            statusReason: 'Automatic classification failed; select the type manually',
            processedAt: new Date(),
          })
          .where(eq(documents.id, documentId))
        await this.publish(documentId, 'needs_review', 'failed')
        return
      }
      await this.handleFailure(job, documentId, runId, error)
      throw error
    }
  }

  /** Warn about multiple documents in one file (spec 6.3), without duplicate issues on reruns. */
  private async syncMultiDocumentWarning(documentId: string, suspected: boolean): Promise<void> {
    await this.db
      .delete(validationIssues)
      .where(
        and(
          eq(validationIssues.documentId, documentId),
          eq(validationIssues.ruleId, MULTI_DOCUMENT_RULE),
          isNull(validationIssues.resolvedAt),
        ),
      )
    if (suspected) {
      await this.db.insert(validationIssues).values({
        documentId,
        fieldName: null,
        ruleId: MULTI_DOCUMENT_RULE,
        severity: 'warning',
        message: 'The file may contain multiple documents; review and split it manually if needed',
        expected: null,
        actual: null,
      })
    }
  }

  private async handleFailure(
    job: Job<ClassifyJob>,
    documentId: string,
    runId: string,
    error: unknown,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error)
    await failRun(this.db, runId, 'classification_failed', detail)

    const unrecoverable = error instanceof UnrecoverableError
    const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1)
    if (!unrecoverable && attemptsLeft > 0) {
      this.logger.warn(
        `Document ${documentId}: classification failed; ${attemptsLeft} attempt(s) left`,
      )
      return
    }

    // The job will not retry automatically; it moves to the dead-letter queue
    // for an operator to retry from the Execution Log (spec 6.10).
    await recordDeadLetter(this.db, {
      documentId,
      runId,
      step: 'classification',
      queue: QUEUE.CLASSIFY,
      jobId: job.id ?? null,
      payload: job.data,
      errorCode: 'classification_failed',
      error,
      attempts: job.attemptsMade + 1,
    })

    const reason = 'Document classification failed. Processing can be retried manually'
    await this.db
      .update(documents)
      .set({ status: 'failed', statusReason: reason })
      .where(eq(documents.id, documentId))
    await this.publish(documentId, 'failed', 'failed')
    this.logger.error(`Document ${documentId}: classification — ${detail}`)
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
      step: 'classification',
      state,
      at: new Date().toISOString(),
    })
  }
}
