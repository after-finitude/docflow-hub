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
   * Экспорт подтверждённого документа (ТЗ 6.8). Идемпотентен по export_key:
   * повторный запрос с тем же ключом не создаёт вторую запись (ТЗ §9).
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
    if (!document) throw new NotFoundException('Документ не найден')

    if (document.status !== 'approved' && document.status !== 'exported') {
      throw new BadRequestException(
        `Экспортировать можно только подтверждённый документ (текущий статус: ${document.status})`,
      )
    }
    if (!document.documentType || document.documentType === 'unknown') {
      // Unknown не экспортируется автоматически (ТЗ 6.3).
      throw new BadRequestException('Документ без определённого типа не экспортируется')
    }
    if (document.duplicateOfId) {
      // Дубликат повторно не экспортируется (ТЗ §10).
      throw new BadRequestException('Дубликат уже принятого документа не экспортируется')
    }

    const destination: ExportDestination = request.destination ?? 'file_json'
    const exportKey = request.exportKey ?? `${documentId}:${destination}`

    const existing = await this.findByKey(exportKey)
    if (existing?.status === 'succeeded') {
      // Второй объект не создаётся и повторно не отправляется (критерий 10).
      this.logger.log(`Экспорт ${exportKey} уже выполнен, возвращается существующий`)
      return this.toDto(existing)
    }

    const adapter = this.adapters.find((candidate) => candidate.destination === destination)
    if (!adapter) {
      throw new BadRequestException(`Назначение ${destination} не настроено`)
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

      // Документ остаётся Approved: отказ назначения не отменяет подтверждения,
      // экспорт доступен для повтора вручную (ТЗ 6.8, критерий 11).
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

      this.logger.warn(`Экспорт ${exportKey} не удался: ${message}`)
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
