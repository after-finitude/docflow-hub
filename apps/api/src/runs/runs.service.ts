import {
  DB,
  DocumentEventsService,
  QUEUE,
  ValidationRunnerService,
  lockDocumentForEdit,
  deadLetters,
  documents,
  workflowRuns,
  writeAudit,
  type Database,
} from '@docflow/core'
import {
  canPerform,
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
 * Stage queued again. Ingest and export are intentionally excluded: ingest
 * would reread the source, while export is retried from the document page and
 * never automatically (spec 6.10).
 */
const QUEUE_BY_STEP: Partial<Record<WorkflowStep, string>> = {
  preprocess: QUEUE.PREPROCESS,
  ocr: QUEUE.OCR,
  classification: QUEUE.CLASSIFY,
  extraction: QUEUE.EXTRACT,
  validation: QUEUE.VALIDATE,
}

/** Execution history and stage actions (spec 5.3). */
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
    private readonly validation: ValidationRunnerService,
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
   * Retry a stage from the dead-letter queue (spec 5.3, 6.10). Requeue with a
   * new correlation_id because this is a separate attempt that must be traced
   * independently.
   */
  async retry(runId: string, user: SessionUser, origin: RequestContext): Promise<RunListItem> {
    return this.db.transaction(async (db) => {
      const initial = await this.findRun(runId, db)
      const document = await lockDocumentForEdit(db, initial.documentId)
      if (!document) throw new NotFoundException('Document not found')
      if (!document.storageKey)
        throw new BadRequestException('The original was not stored. Upload a smaller file')
      const run = await this.findRun(runId, db)
      const queueName = QUEUE_BY_STEP[run.step]
      if (!queueName) {
        throw new BadRequestException(
          run.step === 'export'
            ? 'Export is retried from the document page'
            : `Stage ${run.step} cannot be retried`,
        )
      }
      if (run.state !== 'failed' || !canPerform('retryRun', document.status)) {
        throw new BadRequestException(
          'Only a failed stage of an idle, unexported document can be retried',
        )
      }

      const correlationId = origin.correlationId ?? randomUUID()

      await db
        .update(documents)
        .set({
          status: 'processing',
          statusReason: null,
          processingStep: run.step,
          processingRevision: document.processingRevision + 1,
        })
        .where(eq(documents.id, run.documentId))

      // Resolve DLQ entries because the job is active again; expanded log rows
      // should show that a retry has already been requested.
      await db
        .update(deadLetters)
        .set({ retriedAt: new Date(), retriedBy: user.id })
        .where(and(eq(deadLetters.runId, runId), sql`${deadLetters.retriedAt} is null`))

      await writeAudit(db, {
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
        revision: document.processingRevision + 1,
      })

      await this.events.publish({
        type: 'document',
        documentId: run.documentId,
        status: 'processing',
        step: run.step,
        state: 'pending',
        at: new Date().toISOString(),
      })

      return this.findOne(runId, db)
    })
  }

  /**
   * Send a document to manual review (spec 5.3) after automatic processing is
   * deemed unrecoverable. Preserve existing fields for the Review Workspace;
   * incomplete extraction is better than losing it.
   */
  async toManual(runId: string, user: SessionUser, origin: RequestContext): Promise<RunListItem> {
    return this.db.transaction(async (db) => {
      const initial = await this.findRun(runId, db)
      const document = await lockDocumentForEdit(db, initial.documentId)
      if (!document) throw new NotFoundException('Document not found')
      if (!document.storageKey)
        throw new BadRequestException('The original was not stored. Upload a smaller file')
      const run = await this.findRun(runId, db)
      if (!canPerform('sendToManual', document.status)) {
        throw new BadRequestException('A decided document cannot be sent to manual review')
      }

      await this.validation.runInTransaction(db, run.documentId, {
        autoApprove: false,
        actorType: 'user',
        actorId: user.id,
        correlationId: origin.correlationId,
      })
      await db
        .update(workflowRuns)
        .set({ state: 'failed', finishedAt: new Date(), errorCode: 'manual_handling' })
        .where(and(eq(workflowRuns.documentId, run.documentId), eq(workflowRuns.state, 'running')))
      const reason = 'Sent to manual review by operator'
      await db
        .update(documents)
        .set({
          status: 'needs_review',
          statusReason: reason,
          processedAt: new Date(),
          processingStep: null,
          processingRevision: document.processingRevision + 1,
        })
        .where(eq(documents.id, run.documentId))

      await writeAudit(db, {
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

      return this.findOne(runId, db)
    })
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

  private async findRun(runId: string, db: Database = this.db) {
    const [row] = await db
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

    if (!row) throw new NotFoundException('Execution log entry not found')
    return row
  }

  private async findOne(runId: string, db: Database = this.db): Promise<RunListItem> {
    const [row] = await db
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
    if (!row) throw new NotFoundException('Execution log entry not found')

    const letters = await this.deadLettersFor([runId], db)
    return {
      ...row,
      durationMs:
        row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      deadLetter: letters.get(runId) ?? null,
    }
  }

  /** Latest DLQ entry per stage; older entries remain as retry history. */
  private async deadLettersFor(
    runIds: string[],
    db: Database = this.db,
  ): Promise<Map<string, DeadLetterDto>> {
    const result = new Map<string, DeadLetterDto>()
    if (runIds.length === 0) return result

    const rows = await db
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
