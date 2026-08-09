import {
  DB,
  DocumentEventsService,
  QUEUE,
  deadLetters,
  documents,
  workflowRuns,
  writeAudit,
  type Database,
} from '@docflow/core'
import {
  type DeadLetterDto,
  type RunListItem,
  type RunListPage,
  type RunListQuery,
  type SessionUser,
  type WorkflowStep,
} from '@docflow/shared'
import { InjectQueue } from '@nestjs/bullmq'
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { Queue } from 'bullmq'
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { RequestContext } from '../auth/decorators'

/**
 * Этап, поставленный в очередь заново. Приём и экспорт сюда не входят
 * намеренно: приём означал бы повторное чтение источника, а экспорт
 * повторяется со страницы документа и никогда не автоматически (ТЗ 6.10).
 */
const QUEUE_BY_STEP: Partial<Record<WorkflowStep, string>> = {
  preprocess: QUEUE.PREPROCESS,
  ocr: QUEUE.OCR,
  classification: QUEUE.CLASSIFY,
  extraction: QUEUE.EXTRACT,
  validation: QUEUE.VALIDATE,
}

/** Журнал выполнения и действия над этапами (ТЗ 5.3). */
@Injectable()
export class RunsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly events: DocumentEventsService,
    @InjectQueue(QUEUE.PREPROCESS) private readonly preprocessQueue: Queue,
    @InjectQueue(QUEUE.OCR) private readonly ocrQueue: Queue,
    @InjectQueue(QUEUE.CLASSIFY) private readonly classifyQueue: Queue,
    @InjectQueue(QUEUE.EXTRACT) private readonly extractQueue: Queue,
    @InjectQueue(QUEUE.VALIDATE) private readonly validateQueue: Queue,
  ) {}

  async list(query: RunListQuery): Promise<RunListPage> {
    const conditions: SQL[] = []
    if (query.onlyErrors) conditions.push(eq(workflowRuns.state, 'failed'))
    if (query.step?.length) conditions.push(inArray(workflowRuns.step, query.step))
    if (query.from) conditions.push(gte(workflowRuns.startedAt, new Date(query.from)))
    if (query.to) conditions.push(lte(workflowRuns.startedAt, new Date(query.to)))
    const where = conditions.length ? and(...conditions) : undefined

    const rows = await this.db
      .select({
        id: workflowRuns.id,
        documentId: workflowRuns.documentId,
        documentFilename: documents.originalFilename,
        documentStatus: documents.status,
        step: workflowRuns.step,
        state: workflowRuns.state,
        attempts: workflowRuns.attempts,
        errorCode: workflowRuns.errorCode,
        errorDetail: workflowRuns.errorDetail,
        correlationId: workflowRuns.correlationId,
        startedAt: workflowRuns.startedAt,
        finishedAt: workflowRuns.finishedAt,
      })
      .from(workflowRuns)
      .innerJoin(documents, eq(documents.id, workflowRuns.documentId))
      .where(where)
      .orderBy(desc(workflowRuns.startedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)

    const [counted] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(workflowRuns)
      .innerJoin(documents, eq(documents.id, workflowRuns.documentId))
      .where(where)

    const letters = await this.deadLettersFor(rows.map((row) => row.id))

    return {
      items: rows.map((row) => ({
        ...row,
        durationMs:
          row.startedAt && row.finishedAt
            ? row.finishedAt.getTime() - row.startedAt.getTime()
            : null,
        startedAt: row.startedAt ? row.startedAt.toISOString() : null,
        finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
        deadLetter: letters.get(row.id) ?? null,
      })),
      total: counted?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    }
  }

  /**
   * Повтор этапа из dead-letter queue (ТЗ 5.3, 6.10). Задача ставится заново
   * с новым correlation_id: это отдельная попытка, а не продолжение прежней,
   * и в журнале она должна прослеживаться отдельно.
   */
  async retry(runId: string, user: SessionUser, origin: RequestContext): Promise<RunListItem> {
    const run = await this.findRun(runId)
    const queueName = QUEUE_BY_STEP[run.step]
    if (!queueName) {
      throw new BadRequestException(
        run.step === 'export'
          ? 'Экспорт повторяется со страницы документа'
          : `Этап ${run.step} не повторяется`,
      )
    }
    if (run.documentStatus === 'processing') {
      throw new BadRequestException('Документ уже обрабатывается')
    }

    const correlationId = origin.correlationId ?? randomUUID()

    await this.db
      .update(documents)
      .set({ status: 'processing', statusReason: null })
      .where(eq(documents.id, run.documentId))

    // Записи DLQ закрываются: задача снова в работе, и в раскрытии строки
    // должно быть видно, что повтор уже запрошен.
    await this.db
      .update(deadLetters)
      .set({ retriedAt: new Date(), retriedBy: user.id })
      .where(and(eq(deadLetters.runId, runId), sql`${deadLetters.retriedAt} is null`))

    await writeAudit(this.db, {
      correlationId,
      actorType: 'user',
      actorId: user.id,
      action: 'run.retried',
      objectType: 'workflow_run',
      objectId: runId,
      before: { step: run.step, state: run.state, errorCode: run.errorCode },
      after: { documentId: run.documentId, queue: queueName },
      result: 'success',
      ip: origin.ip,
      userAgent: origin.userAgent,
    })

    await this.queueFor(queueName).add(queueName, {
      documentId: run.documentId,
      correlationId,
    })

    await this.events.publish({
      type: 'document',
      documentId: run.documentId,
      status: 'processing',
      step: run.step,
      state: 'pending',
      at: new Date().toISOString(),
    })

    return this.findOne(runId)
  }

  /**
   * Перевод документа в ручную обработку (ТЗ 5.3): автоматический путь для
   * него признан безнадёжным, дальше с ним работает оператор в Review
   * Workspace. Поля остаются как есть — потерять извлечённое было бы хуже,
   * чем показать неполное.
   */
  async toManual(runId: string, user: SessionUser, origin: RequestContext): Promise<RunListItem> {
    const run = await this.findRun(runId)
    if (run.documentStatus === 'exported') {
      throw new BadRequestException('Выгруженный документ не переводится в ручную обработку')
    }

    const reason = 'Переведён в ручную обработку оператором'
    await this.db
      .update(documents)
      .set({ status: 'needs_review', statusReason: reason, processedAt: new Date() })
      .where(eq(documents.id, run.documentId))

    await writeAudit(this.db, {
      correlationId: origin.correlationId,
      actorType: 'user',
      actorId: user.id,
      action: 'document.manual_handling',
      objectType: 'document',
      objectId: run.documentId,
      before: { status: run.documentStatus, step: run.step },
      result: 'success',
      ip: origin.ip,
      userAgent: origin.userAgent,
    })

    await this.events.publish({
      type: 'document',
      documentId: run.documentId,
      status: 'needs_review',
      step: run.step,
      state: 'failed',
      at: new Date().toISOString(),
    })

    return this.findOne(runId)
  }

  private queueFor(name: string): Queue {
    switch (name) {
      case QUEUE.PREPROCESS:
        return this.preprocessQueue
      case QUEUE.OCR:
        return this.ocrQueue
      case QUEUE.CLASSIFY:
        return this.classifyQueue
      case QUEUE.EXTRACT:
        return this.extractQueue
      default:
        return this.validateQueue
    }
  }

  private async findRun(runId: string) {
    const [row] = await this.db
      .select({
        id: workflowRuns.id,
        documentId: workflowRuns.documentId,
        documentStatus: documents.status,
        step: workflowRuns.step,
        state: workflowRuns.state,
        errorCode: workflowRuns.errorCode,
      })
      .from(workflowRuns)
      .innerJoin(documents, eq(documents.id, workflowRuns.documentId))
      .where(eq(workflowRuns.id, runId))
      .limit(1)

    if (!row) throw new NotFoundException('Запись журнала не найдена')
    return row
  }

  private async findOne(runId: string): Promise<RunListItem> {
    const [row] = await this.db
      .select({
        id: workflowRuns.id,
        documentId: workflowRuns.documentId,
        documentFilename: documents.originalFilename,
        documentStatus: documents.status,
        step: workflowRuns.step,
        state: workflowRuns.state,
        attempts: workflowRuns.attempts,
        errorCode: workflowRuns.errorCode,
        errorDetail: workflowRuns.errorDetail,
        correlationId: workflowRuns.correlationId,
        startedAt: workflowRuns.startedAt,
        finishedAt: workflowRuns.finishedAt,
      })
      .from(workflowRuns)
      .innerJoin(documents, eq(documents.id, workflowRuns.documentId))
      .where(eq(workflowRuns.id, runId))
      .limit(1)
    if (!row) throw new NotFoundException('Запись журнала не найдена')

    const letters = await this.deadLettersFor([runId])
    return {
      ...row,
      durationMs:
        row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      deadLetter: letters.get(runId) ?? null,
    }
  }

  /** Последняя запись DLQ по каждому этапу: прежние остаются историей повторов. */
  private async deadLettersFor(runIds: string[]): Promise<Map<string, DeadLetterDto>> {
    const result = new Map<string, DeadLetterDto>()
    if (runIds.length === 0) return result

    const rows = await this.db
      .select()
      .from(deadLetters)
      .where(inArray(deadLetters.runId, runIds))
      .orderBy(desc(deadLetters.failedAt))

    for (const row of rows) {
      if (!row.runId || result.has(row.runId)) continue
      result.set(row.runId, {
        id: row.id,
        queue: row.queue,
        jobId: row.jobId,
        payload: row.payload,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        stack: row.stack,
        attempts: row.attempts,
        failedAt: row.failedAt.toISOString(),
        retriedAt: row.retriedAt ? row.retriedAt.toISOString() : null,
      })
    }
    return result
  }
}
