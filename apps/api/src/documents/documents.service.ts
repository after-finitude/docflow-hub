import {
  DB,
  DocumentEventsService,
  IngestService,
  QUEUE,
  StorageService,
  ValidationRunnerService,
  documents,
  fields,
  getActiveSchema,
  pages,
  validationIssues,
  workflowRuns,
  writeAudit,
  type Database,
} from '@docflow/core'
import {
  REJECT_REASON_LABELS,
  normalizeByType,
  type ClassifiableDocumentType,
  type DocumentDetail,
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

  async findOne(id: string): Promise<DocumentDetail> {
    const [row] = await this.db
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
    const schema =
      base.documentType && base.documentType !== 'unknown'
        ? await getActiveSchema(this.db, base.documentType)
        : null

    return {
      ...base,
      checksum: row.checksum,
      sourcePath: row.sourcePath,
      processedAt: row.processedAt ? row.processedAt.toISOString() : null,
      pageCount: row.pageCount,
      fields: await this.loadFields(id, base.documentType),
      issues: await this.loadIssues(id),
      thresholds: schema?.thresholds ?? null,
      exports: await this.exports.listForDocument(id),
      // Any unresolved blocking issue disables approval (spec §9).
      canApprove: base.status === 'needs_review' && base.blockingIssues === 0,
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
    const [document] = await this.db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!document) throw new NotFoundException('Document not found')
    if (document.status === 'processing') {
      throw new BadRequestException('Document is still processing')
    }
    if (document.status === 'exported') {
      throw new BadRequestException('An exported document cannot be edited')
    }

    const [field] = await this.db
      .select()
      .from(fields)
      .where(and(eq(fields.documentId, id), eq(fields.name, name)))
      .limit(1)
    if (!field) throw new NotFoundException(`Field ${name} not found`)

    const isArray = Array.isArray(value)
    const rawValue = value === null ? null : isArray ? JSON.stringify(value) : value
    const normalizedValue =
      value === null ? null : isArray ? value : normalizeByType(value, field.valueType)

    await writeAudit(this.db, {
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

    await this.db
      .update(fields)
      .set({
        rawValue,
        normalizedValue,
        isEdited: true,
        // Extraction signals do not apply to a human-entered value, so clear
        // them while revalidation preserves confidence.
        confidenceSignals: null,
        confidence: value === null ? null : 1,
        confidenceReason:
          value === null ? 'Value removed by operator' : 'Value corrected by operator',
      })
      .where(eq(fields.id, field.id))

    await this.validation.run(id, {
      correlationId: origin.correlationId,
      actorType: 'user',
      actorId: user.id,
      // Editing does not approve on the operator's behalf.
      autoApprove: false,
    })

    return this.findOne(id)
  }

  /** Operator approval (spec 5.2). Blocking issues are checked on the server. */
  async approve(id: string, user: SessionUser, origin: RequestContext): Promise<DocumentDetail> {
    const [document] = await this.db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!document) throw new NotFoundException('Document not found')
    if (document.status !== 'needs_review') {
      throw new BadRequestException(`A document with status ${document.status} cannot be approved`)
    }

    // Recheck issues here instead of trusting the client; disabling a UI button
    // is convenience, not protection (spec §9).
    const [{ blocking }] = await this.db
      .select({ blocking: sql<number>`count(*)::int` })
      .from(validationIssues)
      .where(
        and(
          eq(validationIssues.documentId, id),
          eq(validationIssues.severity, 'blocking'),
          isNull(validationIssues.resolvedAt),
        ),
      )

    if (blocking > 0) {
      throw new ConflictException(`Cannot approve: ${blocking} unresolved blocking issue(s)`)
    }

    await this.db
      .update(documents)
      .set({ status: 'approved', statusReason: null, processedAt: new Date() })
      .where(eq(documents.id, id))

    await writeAudit(this.db, {
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
    return this.findOne(id)
  }

  /** Reject with a listed reason and comment (spec 5.2). */
  async reject(
    id: string,
    request: RejectRequest,
    user: SessionUser,
    origin: RequestContext,
  ): Promise<DocumentDetail> {
    const [document] = await this.db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!document) throw new NotFoundException('Document not found')
    if (document.status === 'exported') {
      throw new BadRequestException('An exported document cannot be rejected')
    }

    const reason = REJECT_REASON_LABELS[request.reason]
    const statusReason = request.comment ? `${reason}: ${request.comment}` : reason

    await this.db
      .update(documents)
      .set({ status: 'rejected', statusReason, processedAt: new Date() })
      .where(eq(documents.id, id))

    await writeAudit(this.db, {
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
    return this.findOne(id)
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
    const [row] = await this.db
      .select({ id: documents.id, status: documents.status, documentType: documents.documentType })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row) throw new NotFoundException('Document not found')
    if (row.status === 'processing') throw new BadRequestException('Document is still processing')

    const [{ pagesCount }] = await this.db
      .select({ pagesCount: sql<number>`count(*)::int` })
      .from(pages)
      .where(eq(pages.documentId, id))
    if (!pagesCount) {
      throw new BadRequestException('Document has not been recognized; type cannot be changed')
    }

    await this.db
      .update(documents)
      // A manual selection has maximum confidence (spec 6.3).
      .set({ documentType: type, typeConfidence: 1, status: 'processing', statusReason: null })
      .where(eq(documents.id, id))

    await writeAudit(this.db, {
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
    await this.extractQueue.add('extract', { documentId: id, correlationId })
    await this.events.publish({
      type: 'document',
      documentId: id,
      status: 'processing',
      step: 'extraction',
      state: 'pending',
      at: new Date().toISOString(),
    })

    return this.findOne(id)
  }

  private async loadFields(
    documentId: string,
    documentType: DocumentListItem['documentType'],
  ): Promise<FieldDto[]> {
    const rows = await this.db
      .select()
      .from(fields)
      .where(eq(fields.documentId, documentId))
      .orderBy(fields.name)
    if (rows.length === 0) return []

    // Labels and required flags come from the active schema for display, while
    // document fields remain tied to the schema version used for extraction.
    const schema =
      documentType && documentType !== 'unknown'
        ? await getActiveSchema(this.db, documentType)
        : null
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

  private async loadIssues(documentId: string): Promise<IssueDto[]> {
    const rows = await this.db
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
    return row
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
    return this.storage.signedUrl(row.key)
  }

  async reprocess(id: string, user: SessionUser, origin: RequestContext): Promise<DocumentDetail> {
    const [row] = await this.db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row) throw new NotFoundException('Document not found')
    if (row.status === 'processing') {
      throw new BadRequestException('Document is already processing')
    }

    await writeAudit(this.db, {
      correlationId: origin.correlationId,
      actorType: 'user',
      actorId: user.id,
      action: 'document.reprocess',
      objectType: 'document',
      objectId: id,
      before: { status: row.status },
      result: 'success',
      ip: origin.ip,
      userAgent: origin.userAgent,
    })

    await this.enqueuePreprocess(id, origin.correlationId ?? randomUUID())
    return this.findOne(id)
  }

  private async enqueuePreprocess(documentId: string, correlationId: string): Promise<void> {
    await this.db
      .update(documents)
      .set({ status: 'received', statusReason: null })
      .where(eq(documents.id, documentId))

    await this.preprocessQueue.add('preprocess', { documentId, correlationId })
    await this.events.publish({
      type: 'document',
      documentId,
      status: 'received',
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
      sizeBytes: number
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
      sizeBytes: Number(value.sizeBytes),
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
