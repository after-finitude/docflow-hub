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
 * Первый этап pipeline: проверка файла, миниатюра, число страниц.
 * Успешно подготовленный документ уходит в очередь OCR.
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
    // Параллелизм задаётся из проверенной конфигурации, а не константой
    // в декораторе: декоратор вычисляется до инициализации контейнера.
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
      // Документ удалён, пока задача ждала очереди — это не ошибка обработки.
      this.logger.warn(`Документ ${documentId} не найден, задача пропущена`)
      return
    }

    const runId = await startRun(this.db, documentId, 'preprocess', correlationId)
    await this.updateStatus(documentId, 'processing', null, 'running')

    let buffer: Buffer
    try {
      buffer = await this.storage.getBuffer(document.storageKey)
    } catch (error) {
      // Хранилище недоступно — ошибка транзиентная, задача должна повториться.
      await this.handleTransientFailure(job, documentId, runId, 'storage_unavailable', error)
      throw error
    }

    const result = await inspect(buffer, document.mimeType)

    if (!result.ok) {
      // Дефект самого файла. Повтор бессмысленен, поэтому исключение не
      // бросается: иначе BullMQ трижды перечитывал бы заведомо битый файл.
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
      this.logger.log(`Документ ${documentId} отклонён: ${result.code}`)
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
      // Документ остаётся в processing и передаётся следующему этапу.
      await this.ocrQueue.add('ocr', { documentId, correlationId })
      await this.updateStatus(documentId, 'processing', null, 'succeeded')
      this.logger.log(`Документ ${documentId} подготовлен, страниц: ${result.pageCount}`)
    } catch (error) {
      await this.handleTransientFailure(job, documentId, runId, 'thumbnail_failed', error)
      throw error
    }
  }

  /**
   * Статус Failed выставляется только когда попытки исчерпаны: до этого
   * документ остаётся в обработке, иначе очередь мигала бы ошибкой на каждой
   * промежуточной попытке.
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
      this.logger.warn(`Документ ${documentId}: ${code}, осталось попыток ${attemptsLeft}`)
      return
    }

    // Сама задача больше не повторится: она уходит в dead-letter queue,
    // откуда её повторяет оператор из Execution Log (ТЗ 6.10).
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

    const reason = 'Не удалось подготовить документ. Обработку можно повторить вручную'
    await this.db
      .update(documents)
      .set({ status: 'failed', statusReason: reason })
      .where(eq(documents.id, documentId))
    await this.updateStatus(documentId, 'failed', reason, 'failed')
    this.logger.error(`Документ ${documentId}: ${code} — попытки исчерпаны`)
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
