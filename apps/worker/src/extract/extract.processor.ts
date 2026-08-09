import {
  DB,
  DocumentEventsService,
  ENV,
  PIPELINE_WORKER_OPTIONS,
  QUEUE,
  documents,
  failRun,
  fields,
  finishRun,
  getActiveSchema,
  pages,
  queueConcurrency,
  startRun,
  writeAudit,
  type Database,
  type Env,
} from '@docflow/core'
import {
  matchEvidence,
  normalizeByType,
  scoreConfidence,
  type DocumentStatus,
  type EvidencePage,
  type ExtractionResponse,
  type FieldSpec,
  type WorkflowState,
} from '@docflow/shared'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnModuleInit } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import { asc, eq } from 'drizzle-orm'
import { LLM_PROVIDER, LlmInvalidResponseError, type LlmProvider } from '../llm/llm-provider'

export interface ExtractJob {
  documentId: string
  correlationId: string
}

/** Базовая уверенность извлечения; полный расчёт сигналов — scoreConfidence. */
const EXTRACTION_BASE = 0.9

type LlmField = ExtractionResponse['fields'][number]

/**
 * Извлечение полей по активной схеме типа (ТЗ 6.4) и связывание значений
 * с источниками через evidence → bbox (ТЗ 6.5).
 *
 * Временный терминус pipeline: после извлечения — needs_review. Этап 5
 * вставит валидацию и маршрутизацию до этого перехода.
 */
@Processor(QUEUE.EXTRACT, { ...PIPELINE_WORKER_OPTIONS })
export class ExtractProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ExtractProcessor.name)

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly events: DocumentEventsService,
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
      this.logger.warn(`Документ ${documentId} не найден, задача пропущена`)
      return
    }

    const runId = await startRun(this.db, documentId, 'extraction', correlationId)
    await this.publish(documentId, 'processing', 'running')

    try {
      if (!document.documentType || document.documentType === 'unknown') {
        throw new UnrecoverableError('Извлечение без определённого типа невозможно')
      }

      const schema = await getActiveSchema(this.db, document.documentType)
      if (!schema) {
        throw new UnrecoverableError(`Нет активной схемы для типа ${document.documentType}`)
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

      const response = await this.llm.extract({
        documentType: document.documentType,
        fields: schema.fields,
        pagesText,
      })

      if (this.llm.external) {
        // ТЗ §11: какие страницы и поля отправлены внешнему провайдеру.
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

      // Повторное извлечение заменяет поля целиком.
      await this.db.delete(fields).where(eq(fields.documentId, documentId))
      await this.db.insert(fields).values(rows)

      await this.db
        .update(documents)
        .set({ status: 'needs_review', statusReason: null, processedAt: new Date() })
        .where(eq(documents.id, documentId))

      await finishRun(this.db, runId)
      await this.publish(documentId, 'needs_review', 'succeeded')
      const found = rows.filter((row) => row.rawValue !== null).length
      this.logger.log(`Документ ${documentId}: извлечено ${found}/${schema.fields.length} полей`)
    } catch (error) {
      if (error instanceof LlmInvalidResponseError) {
        // Ручная обработка без потери исходных данных (ТЗ 6.4, §10).
        await failRun(this.db, runId, 'llm_invalid_response', error.message)
        await this.db
          .update(documents)
          .set({
            status: 'needs_review',
            statusReason:
              'Автоматическое извлечение не удалось: заполните поля вручную или повторите',
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

  private buildFieldRow(
    documentId: string,
    schemaVersionId: string,
    spec: FieldSpec,
    llmField: LlmField | undefined,
    evidencePages: EvidencePage[],
  ) {
    const base = {
      documentId,
      schemaVersionId,
      name: spec.name,
      valueType: spec.type,
      isCritical: spec.critical,
      isEdited: false,
    }

    // Отсутствующее поле — null с признаком Missing, не догадка (ТЗ §9).
    if (!llmField || llmField.value === null) {
      return {
        ...base,
        rawValue: null,
        normalizedValue: null,
        confidence: null,
        confidenceReason: 'Значение отсутствует в документе',
        sourcePage: null,
        sourceBbox: null,
        sourceFound: false,
      }
    }

    const isArray = Array.isArray(llmField.value)
    const rawValue = isArray ? JSON.stringify(llmField.value) : (llmField.value as string)
    const normalizedValue = isArray
      ? llmField.value
      : normalizeByType(llmField.value as string, spec.type)

    // Поле без evidence — поле без источника (ТЗ 6.4).
    const match = llmField.evidence
      ? matchEvidence(llmField.evidence.text, llmField.evidence.page, evidencePages)
      : ({ found: false } as const)

    const score = scoreConfidence({
      extraction: EXTRACTION_BASE,
      ocr: match.found ? match.ocrConfidence : null,
      sourceFound: match.found,
      pageMismatch: match.found ? match.pageMismatch : false,
    })

    const reasons = [...score.reasons]
    if (normalizedValue === null && !isArray) {
      reasons.push(`Не удалось привести значение к типу ${spec.type}`)
    }

    return {
      ...base,
      rawValue,
      normalizedValue,
      confidence: score.confidence,
      confidenceReason: reasons.length ? reasons.join('; ') : null,
      sourcePage: match.found ? match.page : null,
      sourceBbox: match.found ? match.bbox : null,
      sourceFound: match.found,
    }
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
      this.logger.warn(
        `Документ ${documentId}: извлечение не удалось, осталось попыток ${attemptsLeft}`,
      )
      return
    }

    const reason = 'Не удалось извлечь поля. Обработку можно повторить вручную'
    await this.db
      .update(documents)
      .set({ status: 'failed', statusReason: reason })
      .where(eq(documents.id, documentId))
    await this.publish(documentId, 'failed', 'failed')
    this.logger.error(`Документ ${documentId}: извлечение — ${detail}`)
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
