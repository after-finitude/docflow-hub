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
  getActiveSchema,
  pages,
  queueConcurrency,
  recordDeadLetter,
  startRun,
  writeAudit,
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

export interface ExtractJob {
  documentId: string
  correlationId: string
}

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

    const [document] = await this.db
      .select({ id: documents.id, documentType: documents.documentType })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)
    if (!document) {
      this.logger.warn(`Document ${documentId} not found; skipping job`)
      return
    }

    const runId = await startRun(this.db, documentId, 'extraction', correlationId)
    await this.publish(documentId, 'processing', 'running')

    try {
      if (!document.documentType || document.documentType === 'unknown') {
        throw new UnrecoverableError('Cannot extract fields without a known document type')
      }

      const schema = await getActiveSchema(this.db, document.documentType)
      if (!schema) {
        throw new UnrecoverableError(`No active schema for type ${document.documentType}`)
      }

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
        response = await this.llm.extract({
          documentType: document.documentType,
          fields: schema.fields,
          pagesText,
        })
      } catch (error) {
        if (!(error instanceof LlmInvalidResponseError)) throw error

        // Supply an editable form on initial failure; never overwrite existing
        // values, field IDs, or their audit links on a failed re-extraction.
        const missing = schema.fields.map((spec) =>
          this.buildFieldRow(documentId, schema.id, spec, undefined, evidencePages),
        )
        if (missing.length) {
          await this.db
            .insert(fields)
            .values(missing)
            .onConflictDoNothing({
              target: [fields.documentId, fields.name],
            })
        }
        // Persist blocking issues before making the manual form available.
        await this.validation.run(documentId, { correlationId, autoApprove: false })
        await failRun(this.db, runId, 'llm_invalid_response', error.message)
        await this.db
          .update(documents)
          .set({ statusReason: 'Automatic extraction failed; fill the fields manually or retry' })
          .where(eq(documents.id, documentId))
        await this.publish(documentId, 'needs_review', 'failed')
        return
      }

      if (this.llm.external) {
        // Spec §11: record which pages and fields were sent to an external provider.
        await writeAudit(this.db, {
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

      const byName = new Map(response.fields.map((field) => [field.name, field]))
      const rows = schema.fields.map((spec) =>
        this.buildFieldRow(documentId, schema.id, spec, byName.get(spec.name), evidencePages),
      )

      // A failed write must leave the previous extraction intact.
      await this.db.transaction(async (tx) => {
        await tx.delete(fields).where(eq(fields.documentId, documentId))
        if (rows.length) await tx.insert(fields).values(rows)
        await finishRun(tx, runId)
      })
      // Keep the document processing and send it to validation.
      await this.validateQueue.add('validate', { documentId, correlationId })
      await this.publish(documentId, 'processing', 'succeeded')
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
    const detail = error instanceof Error ? error.message : String(error)
    await failRun(this.db, runId, 'extraction_failed', detail)

    const unrecoverable = error instanceof UnrecoverableError
    const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1)
    if (!unrecoverable && attemptsLeft > 0) {
      this.logger.warn(`Document ${documentId}: extraction failed; ${attemptsLeft} attempt(s) left`)
      return
    }

    // The job will not retry automatically; it moves to the dead-letter queue
    // for an operator to retry from the Execution Log (spec 6.10).
    await recordDeadLetter(this.db, {
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
    await this.db
      .update(documents)
      .set({ status: 'failed', statusReason: reason })
      .where(eq(documents.id, documentId))
    await this.publish(documentId, 'failed', 'failed')
    this.logger.error(`Document ${documentId}: extraction — ${detail}`)
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
