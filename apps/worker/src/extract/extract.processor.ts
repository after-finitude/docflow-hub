import {
  DB,
  DocumentEventsService,
  ENV,
  PIPELINE_WORKER_OPTIONS,
  QUEUE,
  ValidationRunnerService,
  documents,
  failRun,
  fields,
  finishRun,
  selectExtractionSchema,
  pages,
  queueConcurrency,
  recordDeadLetter,
  beginPipelineRun,
  lockPipelineDocument,
  type PipelineJob,
  writeAudit,
  externalCallRecorder,
  type Database,
  type Env,
} from '@docflow/core'
import {
  buildExtractedField,
  type DocumentStatus,
  type EvidencePage,
  type ExtractionResponse,
  type FieldSpec,
  type WorkflowState,
} from '@docflow/shared'
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnModuleInit } from '@nestjs/common'
import { Queue, UnrecoverableError, type Job } from 'bullmq'
import { asc, eq } from 'drizzle-orm'
import { LLM_PROVIDER, LlmInvalidResponseError, type LlmProvider } from '../llm/llm-provider'

export type ExtractJob = PipelineJob

type LlmField = ExtractionResponse['fields'][number]

/**
 * Extract fields using the type's active schema (spec 6.4), then link values
 * to sources through evidence → bbox (spec 6.5) before validation.
 */
@Processor(QUEUE.EXTRACT, { ...PIPELINE_WORKER_OPTIONS })
export class ExtractProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ExtractProcessor.name)

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly events: DocumentEventsService,
    @InjectQueue(QUEUE.VALIDATE) private readonly validateQueue: Queue,
    private readonly validation: ValidationRunnerService,
  ) {
    super()
  }

  onModuleInit(): void {
    this.worker.concurrency = queueConcurrency(this.env, QUEUE.EXTRACT)
  }

  async process(job: Job<ExtractJob>): Promise<void> {
    const { documentId, correlationId } = job.data

    const started = await beginPipelineRun(this.db, job.data, 'extraction')
    if (!started) return
    const { document, runId } = started
    await this.publish(documentId, 'processing', 'running')

    try {
      if (!document.documentType || document.documentType === 'unknown') {
        throw new UnrecoverableError('Cannot extract fields without a known document type')
      }

      const schema = await this.db.transaction(async (tx) => {
        const current = await lockPipelineDocument(tx, job.data, 'extraction')
        return current ? selectExtractionSchema(tx, current, correlationId) : null
      })
      if (!schema) return

      const pageRows = await this.db
        .select({
          page: pages.pageNumber,
          text: pages.ocrText,
          blocks: pages.blocks,
        })
        .from(pages)
        .where(eq(pages.documentId, documentId))
        .orderBy(asc(pages.pageNumber))

      const pagesText = pageRows
        .filter((row) => (row.text ?? '').trim().length > 0)
        .map((row) => ({ page: row.page, text: row.text ?? '' }))
      const evidencePages: EvidencePage[] = pageRows.map((row) => ({
        pageNumber: row.page,
        blocks: row.blocks ?? [],
      }))

      let response: ExtractionResponse
      try {
        response = await this.llm.extract(
          {
            documentType: document.documentType,
            fields: schema.fields,
            pagesText,
          },
          this.llm.external
            ? externalCallRecorder(this.db, {
                documentId,
                correlationId,
                runId,
                provider: this.llm.name,
              })
            : undefined,
        )
      } catch (error) {
        if (!(error instanceof LlmInvalidResponseError)) throw error

        await this.db.transaction(async (db) => {
          if (!(await lockPipelineDocument(db, job.data, 'extraction'))) return
          await this.validation.runInTransaction(db, documentId, {
            correlationId,
            autoApprove: false,
          })
          await failRun(db, runId, 'llm_invalid_response', error.message)
          await db
            .update(documents)
            .set({
              processingStep: null,
              statusReason: 'Automatic extraction failed; fill the fields manually or retry',
            })
            .where(eq(documents.id, documentId))
          await this.publish(documentId, 'needs_review', 'failed')
        })
        return
      }

      const byName = new Map(response.fields.map((field) => [field.name, field]))
      const rows = schema.fields.map((spec) =>
        this.buildFieldRow(documentId, schema.id, spec, byName.get(spec.name), evidencePages),
      )

      // A failed write must leave the previous extraction intact.
      await this.db.transaction(async (tx) => {
        if (!(await lockPipelineDocument(tx, job.data, 'extraction'))) return
        if (this.llm.external) {
          // Spec §11: record which pages and fields were sent to an external provider.
          await writeAudit(tx, {
            correlationId,
            actorType: 'system',
            action: 'document.llm_external',
            objectType: 'document',
            objectId: documentId,
            after: {
              provider: this.llm.name,
              purpose: 'extraction',
              pages: pagesText.map((p) => p.page),
              fields: schema.fields.map((f) => f.name),
            },
            result: 'success',
          })
        }

        await tx.delete(fields).where(eq(fields.documentId, documentId))
        if (rows.length) await tx.insert(fields).values(rows)
        await writeAudit(tx, {
          correlationId,
          actorType: 'system',
          action: 'document.schema_applied',
          objectType: 'document',
          objectId: documentId,
          before: { schemaId: document.schemaVersionId ?? null },
          after: {
            schemaId: schema.id,
            schemaVersion: schema.version,
            processingRevision: document.processingRevision,
          },
          result: 'success',
        })
        await finishRun(tx, runId)
        await tx
          .update(documents)
          .set({ processingStep: 'validation', schemaVersionId: schema.id })
          .where(eq(documents.id, documentId))
        await this.validateQueue.add('validate', job.data)
        await this.publish(documentId, 'processing', 'succeeded')
      })
      const found = rows.filter((row) => row.rawValue !== null).length
      this.logger.log(`Document ${documentId}: extracted ${found}/${schema.fields.length} fields`)
    } catch (error) {
      await this.handleFailure(job, documentId, runId, error)
      throw error
    }
  }

  /** DB row from the shared field builder also measured by `npm run eval`. */
  private buildFieldRow(
    documentId: string,
    schemaVersionId: string,
    spec: FieldSpec,
    llmField: LlmField | undefined,
    evidencePages: EvidencePage[],
  ) {
    const field = buildExtractedField(spec, llmField, evidencePages)
    return { ...field, documentId, schemaVersionId, isEdited: false }
  }

  private async handleFailure(
    job: Job<ExtractJob>,
    documentId: string,
    runId: string,
    error: unknown,
  ): Promise<void> {
    await this.db.transaction(async (db) => {
      if (!(await lockPipelineDocument(db, job.data, 'extraction'))) return
      const detail = error instanceof Error ? error.message : String(error)
      await failRun(db, runId, 'extraction_failed', detail)

      const unrecoverable = error instanceof UnrecoverableError
      const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1)
      if (!unrecoverable && attemptsLeft > 0) {
        this.logger.warn(
          `Document ${documentId}: extraction failed; ${attemptsLeft} attempt(s) left`,
        )
        return
      }

      // The job will not retry automatically; it moves to the dead-letter queue
      // for an operator to retry from the Execution Log (spec 6.10).
      await recordDeadLetter(db, {
        documentId,
        runId,
        step: 'extraction',
        queue: QUEUE.EXTRACT,
        jobId: job.id ?? null,
        payload: job.data,
        errorCode: 'extraction_failed',
        error,
        attempts: job.attemptsMade + 1,
      })

      const reason = 'Field extraction failed. Processing can be retried manually'
      await db
        .update(documents)
        .set({ status: 'failed', statusReason: reason, processingStep: null })
        .where(eq(documents.id, documentId))
      await this.publish(documentId, 'failed', 'failed')
      this.logger.error(`Document ${documentId}: extraction — ${detail}`)
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
      step: 'extraction',
      state,
      at: new Date().toISOString(),
    })
  }
}
