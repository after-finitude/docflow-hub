import {
  DB,
  DocumentEventsService,
  QUEUE,
  ValidationRunnerService,
  documents,
  auditEvents,
  fields,
  selectExtractionSchema,
  single,
  lockDocument,
  lockDocumentForEdit,
  pages,
  writeAudit,
  type Database,
} from '@docflow/core'
import {
  REJECT_REASON_LABELS,
  canPerform,
  normalizeByType,
  tableValueSchemaFor,
  capSourceConfidence,
  NO_SOURCE_CONFIDENCE_CAP,
  type ClassifiableDocumentType,
  type DocumentDetail,
  type DocumentStatus,
  type RejectRequest,
  type UpdateFieldRequest,
  type SessionUser,
} from '@docflow/shared'
import { InjectQueue } from '@nestjs/bullmq'
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Queue } from 'bullmq'
import { and, eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { RequestContext } from '../auth/decorators'
import { DocumentQueryService } from './document-query.service'

/** Operator decisions and edits; every method holds the document lock. */
@Injectable()
export class DocumentLifecycleService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly events: DocumentEventsService,
    private readonly validation: ValidationRunnerService,
    private readonly query: DocumentQueryService,
    @InjectQueue(QUEUE.PREPROCESS) private readonly preprocessQueue: Queue,
    @InjectQueue(QUEUE.EXTRACT) private readonly extractQueue: Queue,
  ) {}

  private async reviewOpening(db: Database, id: string, actorId: string, revision: number) {
    const [entry] = await db
      .select({ at: auditEvents.createdAt })
      .from(auditEvents)
      .where(
        and(
          // object_type leads audit_events_object_idx; without it the table is scanned.
          eq(auditEvents.objectType, 'document'),
          eq(auditEvents.objectId, id),
          eq(auditEvents.actorId, actorId),
          eq(auditEvents.action, 'document.review_opened'),
          sql`${auditEvents.after}->>'revision' = ${String(revision)}`,
        ),
      )
      .orderBy(auditEvents.createdAt)
      .limit(1)
    return entry?.at ?? null
  }

  async openReview(id: string, user: SessionUser, origin: RequestContext): Promise<void> {
    await this.db.transaction(async (db) => {
      const document = await lockDocument(db, id)
      if (!document) throw new NotFoundException('Document not found')
      if (document.status !== 'needs_review') return
      if (await this.reviewOpening(db, id, user.id, document.processingRevision)) return
      await writeAudit(db, {
        actorType: 'user',
        actorId: user.id,
        action: 'document.review_opened',
        objectType: 'document',
        objectId: id,
        correlationId: origin.correlationId,
        after: { revision: document.processingRevision },
        result: 'success',
      })
    })
  }

  /**
   * Operator value edit (spec 5.2, §9). Store before/after in the audit log,
   * revalidate synchronously, and return the document with updated issues and
   * approval availability.
   */
  async updateField(
    id: string,
    name: string,
    value: UpdateFieldRequest['value'],
    user: SessionUser,
    origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.db.transaction(async (db) => {
      const document = await lockDocumentForEdit(db, id)
      if (!document) throw new NotFoundException('Document not found')
      if (!canPerform('editField', document.status)) {
        throw new ConflictException(`A document with status ${document.status} cannot be edited`)
      }

      const [field] = await db
        .select()
        .from(fields)
        .where(and(eq(fields.documentId, id), eq(fields.name, name)))
        .limit(1)
      if (!field) throw new NotFoundException(`Field ${name} not found`)

      if (value !== null && Array.isArray(value) !== (field.valueType === 'array')) {
        throw new BadRequestException('Value does not match the field type')
      }
      const isArray = Array.isArray(value)
      if (isArray && !tableValueSchemaFor(field.name).safeParse(value).success) {
        throw new BadRequestException('Rows do not match the field table type')
      }
      const rawValue = value === null ? null : isArray ? JSON.stringify(value) : value
      const normalizedValue =
        value === null ? null : isArray ? value : normalizeByType(value, field.valueType)

      if (rawValue === field.rawValue) {
        await this.validation.runInTransaction(db, id, {
          autoApprove: false,
          correlationId: origin.correlationId,
        })
        return this.query.readDetail(db, id, { locked: true })
      }

      await writeAudit(db, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        action: 'field.edited',
        objectType: 'field',
        objectId: field.id,
        before: { name, rawValue: field.rawValue, normalizedValue: field.normalizedValue },
        after: { name, rawValue, normalizedValue },
        result: 'success',
        ip: origin.ip,
        userAgent: origin.userAgent,
      })

      await db
        .update(fields)
        .set({
          rawValue,
          normalizedValue,
          isEdited: true,
          // Extraction signals do not apply to a human-entered value, so clear
          // them while revalidation preserves confidence.
          confidenceSignals: null,
          confidence:
            value === null
              ? null
              : capSourceConfidence(field.confidence ?? NO_SOURCE_CONFIDENCE_CAP, false),
          sourceFound: false,
          sourcePage: null,
          sourceBbox: null,
          confidenceReason:
            value === null
              ? 'Value removed by operator'
              : 'Value corrected by operator; source not verified',
        })
        .where(eq(fields.id, field.id))

      await this.validation.runInTransaction(db, id, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        // Editing does not approve on the operator's behalf.
        autoApprove: false,
      })

      return this.query.readDetail(db, id, { locked: true })
    })
  }

  /** Operator approval (spec 5.2). Blocking issues are checked on the server. */
  async approve(id: string, user: SessionUser, origin: RequestContext): Promise<DocumentDetail> {
    const result = await this.db.transaction(async (db) => {
      const document = await lockDocumentForEdit(db, id)
      if (!document) throw new NotFoundException('Document not found')
      if (!canPerform('approve', document.status)) {
        throw new BadRequestException(
          `A document with status ${document.status} cannot be approved`,
        )
      }

      const validation = await this.validation.runInTransaction(db, id, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        route: false,
      })
      if (validation.decision.blockingCount > 0) {
        // Return the error so refreshed issues commit before the API sends 409.
        return new ConflictException(
          `Cannot approve: ${validation.decision.blockingCount} unresolved blocking issue(s)`,
        )
      }

      const approvedAt = new Date()
      const openedAt = await this.reviewOpening(db, id, user.id, document.processingRevision)
      await db
        .update(documents)
        .set({
          status: 'approved',
          statusReason: null,
          processedAt: approvedAt,
          processingStep: null,
          processingRevision: document.processingRevision + 1,
        })
        .where(eq(documents.id, id))

      await writeAudit(db, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        action: 'document.approved',
        after: {
          revision: document.processingRevision,
          reviewOpenedAt: openedAt?.toISOString() ?? null,
          approvedAt: approvedAt.toISOString(),
          reviewDurationMs: openedAt
            ? Math.max(0, approvedAt.getTime() - openedAt.getTime())
            : null,
        },
        objectType: 'document',
        objectId: id,
        result: 'success',
        ip: origin.ip,
        userAgent: origin.userAgent,
      })

      await this.publishStatus(id, 'approved')
      return this.query.readDetail(db, id, { locked: true })
    })
    if (result instanceof ConflictException) throw result
    return result
  }

  /** Reject with a listed reason and comment (spec 5.2). */
  async reject(
    id: string,
    request: RejectRequest,
    user: SessionUser,
    origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.db.transaction(async (db) => {
      const document = await lockDocumentForEdit(db, id)
      if (!document) throw new NotFoundException('Document not found')
      if (!canPerform('reject', document.status)) {
        throw new ConflictException(`A document with status ${document.status} cannot be rejected`)
      }

      const reason = REJECT_REASON_LABELS[request.reason]
      const statusReason = request.comment ? `${reason}: ${request.comment}` : reason

      await db
        .update(documents)
        .set({
          status: 'rejected',
          statusReason,
          processedAt: new Date(),
          processingStep: null,
          processingRevision: document.processingRevision + 1,
        })
        .where(eq(documents.id, id))

      await writeAudit(db, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        action: 'document.rejected',
        objectType: 'document',
        objectId: id,
        before: { status: document.status },
        after: { reason: request.reason, comment: request.comment ?? null },
        result: 'success',
        ip: origin.ip,
        userAgent: origin.userAgent,
      })

      await this.publishStatus(id, 'rejected')
      return this.query.readDetail(db, id, { locked: true })
    })
  }

  private async publishStatus(documentId: string, status: DocumentStatus): Promise<void> {
    await this.events.publish({
      type: 'document',
      documentId,
      status,
      step: null,
      state: null,
      at: new Date().toISOString(),
    })
  }

  /** Manual type change: restart extraction with the new schema (spec 6.3, §8). */
  async changeType(
    id: string,
    type: ClassifiableDocumentType,
    user: SessionUser,
    origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.db.transaction(async (db) => {
      const row = await lockDocumentForEdit(db, id)

      if (!row) throw new NotFoundException('Document not found')
      if (!canPerform('changeType', row.status))
        throw new ConflictException(`A document with status ${row.status} cannot change type`)

      const { pagesCount } = single(
        await db
          .select({ pagesCount: sql<number>`count(*)::int` })
          .from(pages)
          .where(eq(pages.documentId, id)),
        'page count',
      )
      if (!pagesCount) {
        throw new BadRequestException('Document has not been recognized; type cannot be changed')
      }

      await selectExtractionSchema(
        db,
        {
          ...row,
          documentType: type,
          extractionSchemaVersionId: null,
          processingRevision: row.processingRevision + 1,
        },
        origin.correlationId,
      )
      await db
        .update(documents)
        // A manual selection has maximum confidence (spec 6.3).
        .set({
          documentType: type,
          typeConfidence: 1,
          status: 'processing',
          statusReason: null,
          processingRevision: row.processingRevision + 1,
          processingStep: 'extraction',
        })
        .where(eq(documents.id, id))

      await writeAudit(db, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        action: 'document.type_changed',
        objectType: 'document',
        objectId: id,
        before: { documentType: row.documentType },
        after: { documentType: type },
        result: 'success',
        ip: origin.ip,
        userAgent: origin.userAgent,
      })

      const correlationId = origin.correlationId ?? randomUUID()
      await this.extractQueue.add('extract', {
        documentId: id,
        correlationId,
        revision: row.processingRevision + 1,
      })
      await this.events.publish({
        type: 'document',
        documentId: id,
        status: 'processing',
        step: 'extraction',
        state: 'pending',
        at: new Date().toISOString(),
      })

      return this.query.readDetail(db, id, { locked: true })
    })
  }

  async reprocess(id: string, user: SessionUser, origin: RequestContext): Promise<DocumentDetail> {
    return this.db.transaction(async (db) => {
      const row = await lockDocumentForEdit(db, id)

      if (!row) throw new NotFoundException('Document not found')
      if (!row.storageKey)
        throw new BadRequestException('The original was not stored. Upload a smaller file')
      if (!canPerform('reprocess', row.status)) {
        throw new BadRequestException(`A document with status ${row.status} cannot be reprocessed`)
      }

      await writeAudit(db, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        action: 'document.reprocess',
        objectType: 'document',
        objectId: id,
        before: { status: row.status, schemaVersionId: row.schemaVersionId },
        after: { schemaSelection: 'active_in_new_run' },
        result: 'success',
        ip: origin.ip,
        userAgent: origin.userAgent,
      })

      await this.enqueuePreprocess(
        db,
        id,
        origin.correlationId ?? randomUUID(),
        row.processingRevision + 1,
      )
      return this.query.readDetail(db, id, { locked: true })
    })
  }

  private async enqueuePreprocess(
    db: Database,
    documentId: string,
    correlationId: string,
    revision: number,
  ): Promise<void> {
    await db
      .update(documents)
      .set({
        status: 'processing',
        statusReason: null,
        processingRevision: revision,
        processingStep: 'preprocess',
        extractionSchemaVersionId: null,
      })
      .where(eq(documents.id, documentId))

    await this.preprocessQueue.add('preprocess', { documentId, correlationId, revision })
    await this.events.publish({
      type: 'document',
      documentId,
      status: 'processing',
      step: null,
      state: null,
      at: new Date().toISOString(),
    })
  }
}
