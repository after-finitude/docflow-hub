import {
  DB,
  DocumentEventsService,
  IngestService,
  QUEUE,
  StorageService,
  ValidationRunnerService,
  documents,
  fields,
  getDocumentSchema,
  selectExtractionSchema,
  type ActiveSchema,
  lockDocument,
  lockDocumentForEdit,
  pages,
  validationIssues,
  workflowRuns,
  writeAudit,
  type Database,
} from '@docflow/core'
import {
  REJECT_REASON_LABELS,
  normalizeByType,
  capSourceConfidence,
  NO_SOURCE_CONFIDENCE_CAP,
  type ClassifiableDocumentType,
  type DocumentDetail,
  type OversizedUploadRequest,
  type DocumentStatus,
  type RejectRequest,
  type UpdateFieldRequest,
  type DocumentListItem,
  type DocumentListPage,
  type DocumentListQuery,
  type DocumentPage,
  type FieldDto,
  type IssueDto,
  type SessionUser,
  type WorkflowState,
  type WorkflowStep,
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
import { and, desc, eq, exists, gte, inArray, isNull, lte, not, sql, type SQL } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { RequestContext } from '../auth/decorators'
import { ExportService } from '../export/export.service'
import type { UploadedDocument } from './uploaded-document'

/**
 * Document reference in an outer query. Qualify the table explicitly: inside
 * SQL templates Drizzle emits unqualified columns, so `documents.id` would
 * become `"id"` and resolve to the subquery's own column. The join would silently
 * become `document_id = id`, leaving issue counts and the current stage empty.
 */
const documentRef = sql`${sql.identifier('documents')}.${sql.identifier('id')}`

/** Fields computed by subqueries; empty before stages 4–5, but the response shape is final. */
const listColumns = {
  id: documents.id,
  originalFilename: documents.originalFilename,
  mimeType: documents.mimeType,
  sizeBytes: documents.sizeBytes,
  hasOriginal: sql<boolean>`${documents.storageKey} is not null`.as('has_original'),
  sourceType: documents.sourceType,
  documentType: documents.documentType,
  typeConfidence: documents.typeConfidence,
  status: documents.status,
  statusReason: documents.statusReason,
  thumbnailKey: documents.thumbnailKey,
  duplicateOfId: documents.duplicateOfId,
  versionNumber: documents.versionNumber,
  previousVersionId: documents.previousVersionId,
  isActive: documents.isActive,
  receivedAt: documents.receivedAt,
  minCriticalConfidence: sql<number | null>`(
    select min(${fields.confidence}) from ${fields}
    where ${fields.documentId} = ${documentRef} and ${fields.isCritical}
  )`.as('min_critical_confidence'),
  blockingIssues: sql<number>`(
    select count(*)::int from ${validationIssues}
    where ${validationIssues.documentId} = ${documentRef}
      and ${validationIssues.severity} = 'blocking'
      and ${validationIssues.resolvedAt} is null
  )`.as('blocking_issues'),
  warningIssues: sql<number>`(
    select count(*)::int from ${validationIssues}
    where ${validationIssues.documentId} = ${documentRef}
      and ${validationIssues.severity} = 'warning'
      and ${validationIssues.resolvedAt} is null
  )`.as('warning_issues'),
  currentStep: sql<WorkflowStep | null>`(
    select ${workflowRuns.step} from ${workflowRuns}
    where ${workflowRuns.documentId} = ${documentRef}
    order by ${workflowRuns.startedAt} desc nulls last limit 1
  )`.as('current_step'),
  currentStepState: sql<WorkflowState | null>`(
    select ${workflowRuns.state} from ${workflowRuns}
    where ${workflowRuns.documentId} = ${documentRef}
    order by ${workflowRuns.startedAt} desc nulls last limit 1
  )`.as('current_step_state'),
}

type ListRow = { [K in keyof typeof listColumns]: unknown }

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly events: DocumentEventsService,
    private readonly validation: ValidationRunnerService,
    private readonly ingest: IngestService,
    private readonly exports: ExportService,
    @InjectQueue(QUEUE.PREPROCESS) private readonly preprocessQueue: Queue,
    @InjectQueue(QUEUE.EXTRACT) private readonly extractQueue: Queue,
  ) {}

  async rejectOversized(
    body: Omit<OversizedUploadRequest, 'sizeBytes'> & { sizeBytes: number | null },
    user: SessionUser,
    origin: RequestContext,
  ): Promise<DocumentListItem> {
    const id = await this.ingest.rejectOversized({
      ...body,
      actorType: 'user',
      actorId: user.id,
      correlationId: origin.correlationId ?? randomUUID(),
      ip: origin.ip,
      userAgent: origin.userAgent,
    })
    return this.findOne(id)
  }

  async upload(
    file: UploadedDocument,
    user: SessionUser,
    origin: RequestContext,
  ): Promise<DocumentListItem> {
    // Upload and source sync share ingest so checksums, duplicates, and versions
    // do not depend on how a file entered the system.
    const result = await this.ingest.ingest({
      buffer: file.buffer,
      filename: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      sourceType: 'upload',
      actorType: 'user',
      actorId: user.id,
      auditAction: 'document.upload',
      correlationId: origin.correlationId ?? randomUUID(),
      ip: origin.ip,
      userAgent: origin.userAgent,
    })

    // UI uploads have no source path, so ingest always creates a document and
    // the skipped branch is unreachable.
    return this.findOne(result.documentId!)
  }

  /**
   * Original replacement (spec §10). Do not overwrite the file: create a new
   * version and retain the inactive previous version with its decision history.
   */
  async replaceFile(
    id: string,
    file: UploadedDocument,
    user: SessionUser,
    origin: RequestContext,
  ): Promise<DocumentListItem> {
    const [document] = await this.db
      .select({
        id: documents.id,
        status: documents.status,
        sourceType: documents.sourceType,
        versionNumber: documents.versionNumber,
        isActive: documents.isActive,
        checksum: documents.checksum,
      })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!document) throw new NotFoundException('Document not found')

    if (document.sourceType !== 'upload') {
      // Otherwise the next sync would restore the source contents and silently
      // discard the operator's replacement.
      throw new BadRequestException(
        'This document came from a source; replace the file at the source',
      )
    }
    if (!document.isActive) {
      throw new BadRequestException('Document is inactive; only the latest version can be replaced')
    }
    if (document.status === 'exported') {
      throw new BadRequestException('An exported document cannot be replaced')
    }
    if (document.status === 'processing') {
      throw new BadRequestException('Document is still processing')
    }

    const result = await this.ingest.ingest({
      buffer: file.buffer,
      filename: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      sourceType: 'upload',
      actorType: 'user',
      actorId: user.id,
      auditAction: 'document.file_replaced',
      correlationId: origin.correlationId ?? randomUUID(),
      ip: origin.ip,
      userAgent: origin.userAgent,
      replaces: { id: document.id, versionNumber: document.versionNumber },
    })

    if (result.action === 'skipped') {
      throw new BadRequestException('The same file was uploaded; there is nothing to replace')
    }
    return this.findOne(result.documentId!)
  }

  async list(query: DocumentListQuery): Promise<DocumentListPage> {
    const conditions: SQL[] = []
    if (query.status?.length) conditions.push(inArray(documents.status, query.status))
    if (query.type?.length) conditions.push(inArray(documents.documentType, query.type))
    if (query.source?.length) conditions.push(inArray(documents.sourceType, query.source))
    if (query.receivedFrom) conditions.push(gte(documents.receivedAt, new Date(query.receivedFrom)))
    if (query.receivedTo) conditions.push(lte(documents.receivedAt, new Date(query.receivedTo)))

    if (query.hasBlocking !== undefined) {
      const hasBlocking = exists(
        this.db
          .select({ one: sql`1` })
          .from(validationIssues)
          .where(
            and(
              eq(validationIssues.documentId, documents.id),
              eq(validationIssues.severity, 'blocking'),
              isNull(validationIssues.resolvedAt),
            ),
          ),
      )
      conditions.push(query.hasBlocking ? hasBlocking : not(hasBlocking))
    }

    const where = conditions.length ? and(...conditions) : undefined

    const rows = await this.db
      .select(listColumns)
      .from(documents)
      .where(where)
      .orderBy(desc(documents.receivedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)

    const [counted] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(documents)
      .where(where)

    return {
      items: rows.map((row) => this.toListItem(row)),
      total: counted?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    }
  }

  async findOne(id: string, db?: Database): Promise<DocumentDetail> {
    if (!db) return this.db.transaction((tx) => this.findOne(id, tx))
    const document = await lockDocument(db, id)
    const [row] = await db
      .select({
        ...listColumns,
        checksum: documents.checksum,
        sourcePath: documents.sourcePath,
        processedAt: documents.processedAt,
        pageCount: documents.pageCount,
      })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row) throw new NotFoundException('Document not found')

    const base = this.toListItem(row)
    const schema = await getDocumentSchema(db, document)

    const loadedFields = await this.loadFields(id, schema, db)
    return {
      ...base,
      checksum: row.checksum,
      sourcePath: row.sourcePath,
      processedAt: row.processedAt ? row.processedAt.toISOString() : null,
      pageCount: row.pageCount,
      fields: loadedFields,
      schemaVersionId: schema?.id ?? null,
      schemaVersion: schema?.version ?? null,
      issues: await this.loadIssues(id, db),
      thresholds: schema?.thresholds ?? null,
      exports: await this.exports.listForDocument(id, db),
      // Any unresolved blocking issue disables approval (spec §9).
      canApprove:
        base.status === 'needs_review' &&
        schema !== null &&
        base.documentType === schema.documentType &&
        base.blockingIssues === 0 &&
        schema.fields
          .filter((spec) => spec.required)
          .every((spec) =>
            loadedFields.some(
              (field) => field.name === spec.name && field.normalizedValue !== null,
            ),
          ),
    }
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
      if (!['needs_review', 'approved', 'failed'].includes(document.status)) {
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
      const rawValue = value === null ? null : isArray ? JSON.stringify(value) : value
      const normalizedValue =
        value === null ? null : isArray ? value : normalizeByType(value, field.valueType)

      if (rawValue === field.rawValue) {
        await this.validation.runInTransaction(db, id, {
          autoApprove: false,
          correlationId: origin.correlationId,
        })
        return this.findOne(id, db)
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

      return this.findOne(id, db)
    })
  }

  /** Operator approval (spec 5.2). Blocking issues are checked on the server. */
  async approve(id: string, user: SessionUser, origin: RequestContext): Promise<DocumentDetail> {
    const result = await this.db.transaction(async (db) => {
      const document = await lockDocumentForEdit(db, id)
      if (!document) throw new NotFoundException('Document not found')
      if (document.status !== 'needs_review') {
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

      await db
        .update(documents)
        .set({
          status: 'approved',
          statusReason: null,
          processedAt: new Date(),
          processingStep: null,
          processingRevision: document.processingRevision + 1,
        })
        .where(eq(documents.id, id))

      await writeAudit(db, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        action: 'document.approved',
        objectType: 'document',
        objectId: id,
        result: 'success',
        ip: origin.ip,
        userAgent: origin.userAgent,
      })

      await this.publishStatus(id, 'approved')
      return this.findOne(id, db)
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
      if (!['needs_review', 'approved', 'failed'].includes(document.status)) {
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
      return this.findOne(id, db)
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
      if (['received', 'processing', 'exported'].includes(row.status))
        throw new ConflictException(`A document with status ${row.status} cannot change type`)

      const [{ pagesCount }] = await db
        .select({ pagesCount: sql<number>`count(*)::int` })
        .from(pages)
        .where(eq(pages.documentId, id))
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

      return this.findOne(id, db)
    })
  }

  private async loadFields(
    documentId: string,
    schema: ActiveSchema | null,
    db: Database,
  ): Promise<FieldDto[]> {
    const rows = await db
      .select()
      .from(fields)
      .where(eq(fields.documentId, documentId))
      .orderBy(fields.name)
    if (rows.length === 0) return []

    const specs = new Map((schema?.fields ?? []).map((spec) => [spec.name, spec]))

    return rows.map((row) => ({
      name: row.name,
      label: specs.get(row.name)?.label ?? row.name,
      valueType: row.valueType,
      rawValue: row.rawValue,
      normalizedValue: row.normalizedValue,
      confidence: row.confidence,
      confidenceReason: row.confidenceReason,
      sourcePage: row.sourcePage,
      sourceBbox: row.sourceBbox,
      sourceFound: row.sourceFound,
      isCritical: row.isCritical,
      isRequired: specs.get(row.name)?.required ?? false,
      isEdited: row.isEdited,
    }))
  }

  private async loadIssues(documentId: string, db: Database): Promise<IssueDto[]> {
    const rows = await db
      .select()
      .from(validationIssues)
      .where(eq(validationIssues.documentId, documentId))
      .orderBy(desc(validationIssues.severity), validationIssues.createdAt)

    return rows.map((row) => ({
      id: row.id,
      fieldName: row.fieldName,
      ruleId: row.ruleId,
      severity: row.severity,
      message: row.message,
      expected: row.expected,
      actual: row.actual,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    }))
  }

  /** Per-page OCR result: text, coordinate blocks, and confidence (spec 6.2, §8). */
  async pages(id: string): Promise<DocumentPage[]> {
    const [exists_] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!exists_) throw new NotFoundException('Document not found')

    const rows = await this.db
      .select({
        pageNumber: pages.pageNumber,
        text: pages.ocrText,
        confidence: pages.ocrConfidence,
        width: pages.width,
        height: pages.height,
        blocks: pages.blocks,
      })
      .from(pages)
      .where(eq(pages.documentId, id))
      .orderBy(pages.pageNumber)

    return rows.map((row) => ({ ...row, blocks: row.blocks ?? [] }))
  }

  /** Source data for rendering a page in the viewer. */
  async fileLocation(id: string): Promise<{ storageKey: string; mimeType: string }> {
    const [row] = await this.db
      .select({ storageKey: documents.storageKey, mimeType: documents.mimeType })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!row) throw new NotFoundException('Document not found')
    if (!row.storageKey) throw new NotFoundException('The original was not stored')
    return { ...row, storageKey: row.storageKey }
  }

  /** Serve thumbnails through the guarded API rather than a signed URL. */
  async thumbnail(id: string): Promise<Readable> {
    const [row] = await this.db
      .select({ key: documents.thumbnailKey })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row) throw new NotFoundException('Document not found')
    if (!row.key) throw new NotFoundException('Thumbnail is not ready yet')
    return this.storage.getStream(row.key)
  }

  async signedFileUrl(id: string): Promise<string> {
    const [row] = await this.db
      .select({ key: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row) throw new NotFoundException('Document not found')
    if (!row.key) throw new NotFoundException('The original was not stored')
    return this.storage.signedUrl(row.key)
  }

  async reprocess(id: string, user: SessionUser, origin: RequestContext): Promise<DocumentDetail> {
    return this.db.transaction(async (db) => {
      const row = await lockDocumentForEdit(db, id)

      if (!row) throw new NotFoundException('Document not found')
      if (!row.storageKey)
        throw new BadRequestException('The original was not stored. Upload a smaller file')
      if (['received', 'processing', 'exported'].includes(row.status)) {
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
      return this.findOne(id, db)
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

  private toListItem(row: ListRow): DocumentListItem {
    const value = row as unknown as {
      id: string
      originalFilename: string
      mimeType: string
      sizeBytes: number | null
      hasOriginal: boolean
      sourceType: DocumentListItem['sourceType']
      documentType: DocumentListItem['documentType']
      typeConfidence: number | null
      status: DocumentListItem['status']
      statusReason: string | null
      thumbnailKey: string | null
      duplicateOfId: string | null
      versionNumber: number
      previousVersionId: string | null
      isActive: boolean
      receivedAt: Date
      minCriticalConfidence: number | null
      blockingIssues: number
      warningIssues: number
      currentStep: WorkflowStep | null
      currentStepState: WorkflowState | null
    }

    return {
      id: value.id,
      originalFilename: value.originalFilename,
      mimeType: value.mimeType,
      sizeBytes: value.sizeBytes === null ? null : Number(value.sizeBytes),
      hasOriginal: value.hasOriginal,
      sourceType: value.sourceType,
      documentType: value.documentType,
      typeConfidence: value.typeConfidence,
      status: value.status,
      statusReason: value.statusReason,
      minCriticalConfidence: value.minCriticalConfidence,
      blockingIssues: value.blockingIssues,
      warningIssues: value.warningIssues,
      hasThumbnail: Boolean(value.thumbnailKey),
      duplicateOfId: value.duplicateOfId,
      versionNumber: value.versionNumber,
      previousVersionId: value.previousVersionId,
      isActive: value.isActive,
      currentStep: value.currentStep,
      currentStepState: value.currentStepState,
      receivedAt: value.receivedAt.toISOString(),
    }
  }
}
