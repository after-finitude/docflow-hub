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
  startRun,
  writeAudit,
  type Database,
  type Env,
} from '@docflow/core'
import type { DocumentStatus, WorkflowState } from '@docflow/shared'
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnModuleInit } from '@nestjs/common'
import { Queue, UnrecoverableError, type Job } from 'bullmq'
import { eq } from 'drizzle-orm'
import { OCR_PROVIDER, type OcrProvider } from './ocr-provider'

export interface OcrJob {
  documentId: string
  correlationId: string
}

/**
 * Второй этап pipeline: распознавание и постраничное сохранение текста
 * с координатами блоков (ТЗ 6.2). Дальше — классификация.
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

    const [document] = await this.db
      .select({ id: documents.id, storageKey: documents.storageKey, mimeType: documents.mimeType })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)

    if (!document) {
      this.logger.warn(`Документ ${documentId} не найден, задача пропущена`)
      return
    }

    const runId = await startRun(this.db, documentId, 'ocr', correlationId)
    await this.publish(documentId, 'processing', 'running')

    try {
      const buffer = await this.storage.getBuffer(document.storageKey)
      const result = await this.provider.recognize(buffer, document.mimeType)

      // Повторный прогон заменяет страницы целиком: строки не накапливаются.
      await this.db.delete(pages).where(eq(pages.documentId, documentId))
      if (result.pages.length > 0) {
        await this.db.insert(pages).values(
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

      // ТЗ §11: какие страницы ушли внешнему провайдеру — фиксируется.
      const sentPages = result.pages.filter((page) => page.sentToProvider).map((p) => p.pageNumber)
      if (this.provider.external && sentPages.length > 0) {
        await writeAudit(this.db, {
          correlationId,
          actorType: 'system',
          action: 'document.ocr_external',
          objectType: 'document',
          objectId: documentId,
          after: { provider: this.provider.name, pages: sentPages },
          result: 'success',
        })
      }

      await this.db
        .update(documents)
        .set({ pageCount: result.pages.length })
        .where(eq(documents.id, documentId))

      await finishRun(this.db, runId)
      await this.classifyQueue.add('classify', { documentId, correlationId })
      await this.publish(documentId, 'processing', 'succeeded')
      this.logger.log(
        `Документ ${documentId}: OCR (${this.provider.name}) выполнен, страниц ${result.pages.length}`,
      )
    } catch (error) {
      await this.handleFailure(job, documentId, runId, error)
      throw error
    }
  }

  /** Failed — только когда попытки исчерпаны либо ошибка неустранима. */
  private async handleFailure(
    job: Job<OcrJob>,
    documentId: string,
    runId: string,
    error: unknown,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error)
    await failRun(this.db, runId, 'ocr_failed', detail)

    const unrecoverable = error instanceof UnrecoverableError
    const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade + 1)
    if (!unrecoverable && attemptsLeft > 0) {
      this.logger.warn(`Документ ${documentId}: OCR не удался, осталось попыток ${attemptsLeft}`)
      return
    }

    // Сама задача больше не повторится: она уходит в dead-letter queue,
    // откуда её повторяет оператор из Execution Log (ТЗ 6.10).
    await recordDeadLetter(this.db, {
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

    const reason = 'Не удалось распознать документ. Обработку можно повторить вручную'
    await this.db
      .update(documents)
      .set({ status: 'failed', statusReason: reason })
      .where(eq(documents.id, documentId))
    await this.publish(documentId, 'failed', 'failed')
    this.logger.error(
      `Документ ${documentId}: OCR — ${unrecoverable ? 'неустранимая ошибка' : 'попытки исчерпаны'}: ${detail}`,
    )
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
