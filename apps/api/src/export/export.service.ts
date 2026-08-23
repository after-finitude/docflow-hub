import {
  DB,
  DocumentEventsService,
  EXPORT_MAPPINGS,
  documentExports,
  documents,
  fields,
  getActiveSchema,
  validationIssues,
  writeAudit,
  type Database,
} from '@docflow/core'
import {
  buildCanonicalDocument,
  type CanonicalInputField,
  type ExportDestination,
  type ExportDto,
  type ExportRequest,
  type SessionUser,
} from '@docflow/shared'
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import type { RequestContext } from '../auth/decorators'
import { DestinationUnavailableError, type ExportAdapter } from './export-adapter'
import { EXPORT_ADAPTERS } from './export-adapter'

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name)

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(EXPORT_ADAPTERS) private readonly adapters: ExportAdapter[],
    private readonly events: DocumentEventsService,
  ) {}

  async listForDocument(documentId: string): Promise<ExportDto[]> {
    const rows = await this.db
      .select()
      .from(documentExports)
      .where(eq(documentExports.documentId, documentId))
      .orderBy(documentExports.exportKey)
    return rows.map((row) => this.toDto(row))
  }

  /**
   * Export an approved document (spec 6.8), idempotent by export_key. A repeated
   * request with the same key does not create another record (spec §9).
   */
  async export(
    documentId: string,
    request: ExportRequest,
    user: SessionUser,
    origin: RequestContext,
  ): Promise<ExportDto> {
    const [document] = await this.db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)
    if (!document) throw new NotFoundException('Document not found')

    if (document.status !== 'approved' && document.status !== 'exported') {
      throw new BadRequestException(
        `Only an approved document can be exported (current status: ${document.status})`,
      )
    }
    if (!document.documentType || document.documentType === 'unknown') {
      // Unknown documents are never exported automatically (spec 6.3).
      throw new BadRequestException('A document without a known type cannot be exported')
    }
    if (document.duplicateOfId) {
      // Do not export a duplicate again (spec §10).
      throw new BadRequestException('A duplicate of an accepted document cannot be exported')
    }

    const destination: ExportDestination = request.destination ?? 'file_json'
    const exportKey = request.exportKey ?? `${documentId}:${destination}`

    const existing = await this.findByKey(exportKey)
    if (existing?.status === 'succeeded') {
      // Do not create or send a second object (criterion 10).
      this.logger.log(`Export ${exportKey} already completed; returning the existing record`)
      return this.toDto(existing)
    }

    const adapter = this.adapters.find((candidate) => candidate.destination === destination)
    if (!adapter) {
      throw new BadRequestException(`Destination ${destination} is not configured`)
    }

    const canonical = await this.buildCanonical(document)
    const mapping = EXPORT_MAPPINGS[document.documentType]

    const record = existing ?? (await this.createRecord(documentId, destination, exportKey))
    const attempts = record.attempts + 1

    try {
      const payloadRef = await adapter.send(canonical, mapping, exportKey)

      await this.db
        .update(documentExports)
        .set({ status: 'succeeded', payloadRef, errorCode: null, attempts, exportedAt: new Date() })
        .where(eq(documentExports.id, record.id))

      await this.db
        .update(documents)
        .set({ status: 'exported', statusReason: null })
        .where(eq(documents.id, documentId))

      await writeAudit(this.db, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        action: 'document.exported',
        objectType: 'document',
        objectId: documentId,
        after: { destination, exportKey, payloadRef, attempts },
        result: 'success',
        ip: origin.ip,
        userAgent: origin.userAgent,
      })

      await this.events.publish({
        type: 'document',
        documentId,
        status: 'exported',
        step: 'export',
        state: 'succeeded',
        at: new Date().toISOString(),
      })

      return this.toDto({
        ...record,
        status: 'succeeded',
        payloadRef,
        attempts,
        exportedAt: new Date(),
      })
    } catch (error) {
      const code = error instanceof DestinationUnavailableError ? error.code : 'export_failed'
      const message = error instanceof Error ? error.message : String(error)

      // The document remains Approved because a destination failure does not
      // undo approval; manual retry remains available (spec 6.8, criterion 11).
      await this.db
        .update(documentExports)
        .set({ status: 'failed', errorCode: code, attempts })
        .where(eq(documentExports.id, record.id))

      await writeAudit(this.db, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        action: 'document.export_failed',
        objectType: 'document',
        objectId: documentId,
        after: { destination, exportKey, errorCode: code, message, attempts },
        result: 'failure',
        ip: origin.ip,
        userAgent: origin.userAgent,
      })

      this.logger.warn(`Export ${exportKey} failed: ${message}`)
      return this.toDto({ ...record, status: 'failed', errorCode: code, attempts })
    }
  }

  private async findByKey(exportKey: string) {
    const [row] = await this.db
      .select()
      .from(documentExports)
      .where(eq(documentExports.exportKey, exportKey))
      .limit(1)
    return row
  }

  private async createRecord(
    documentId: string,
    destination: ExportDestination,
    exportKey: string,
  ) {
    const [created] = await this.db
      .insert(documentExports)
      .values({ documentId, destination, exportKey, status: 'pending', attempts: 0 })
      .returning()
    return created
  }

  private async buildCanonical(document: typeof documents.$inferSelect) {
    const schema =
      document.documentType && document.documentType !== 'unknown'
        ? await getActiveSchema(this.db, document.documentType)
        : null

    const fieldRows = await this.db
      .select()
      .from(fields)
      .where(eq(fields.documentId, document.id))
      .orderBy(fields.name)

    const warnings = await this.db
      .select({
        ruleId: validationIssues.ruleId,
        fieldName: validationIssues.fieldName,
        message: validationIssues.message,
      })
      .from(validationIssues)
      .where(and(eq(validationIssues.documentId, document.id), isNull(validationIssues.resolvedAt)))

    const canonicalFields: CanonicalInputField[] = fieldRows.map((row) => ({
      name: row.name,
      valueType: row.valueType,
      rawValue: row.rawValue,
      normalizedValue: row.normalizedValue,
      confidence: row.confidence,
      isEdited: row.isEdited,
      sourcePage: row.sourcePage,
      sourceBbox: row.sourceBbox,
      sourceFound: row.sourceFound,
    }))

    return buildCanonicalDocument({
      documentId: document.id,
      documentType: document.documentType!,
      schemaVersion: schema?.version ?? null,
      sourceType: document.sourceType,
      originalFilename: document.originalFilename,
      checksum: document.checksum,
      receivedAt: document.receivedAt.toISOString(),
      approvedAt: document.processedAt ? document.processedAt.toISOString() : null,
      fields: canonicalFields,
      warnings,
      generatedAt: new Date().toISOString(),
    })
  }

  private toDto(row: typeof documentExports.$inferSelect): ExportDto {
    return {
      id: row.id,
      destination: row.destination as ExportDestination,
      exportKey: row.exportKey,
      status: row.status,
      payloadRef: row.payloadRef,
      errorCode: row.errorCode,
      attempts: row.attempts,
      exportedAt: row.exportedAt ? row.exportedAt.toISOString() : null,
    }
  }
}
