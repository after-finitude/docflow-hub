import {
  DB,
  DB_POOL,
  databaseSchema,
  startRun,
  finishRun,
  failRun,
  DocumentEventsService,
  ENV,
  exportSettings,
  type Env,
  StorageService,
  ValidationRunnerService,
  lockDocument,
  documentExports,
  documents,
  fields,
  getDocumentSchema,
  validationIssues,
  writeAudit,
  type Database,
} from '@docflow/core'
import {
  buildCanonicalDocument,
  exportSettingsSchema,
  type ExportSettings,
  type CanonicalInputField,
  type ExportDto,
  type ExportRequest,
  type SessionUser,
} from '@docflow/shared'
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
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
    private readonly storage: StorageService,
    private readonly validation: ValidationRunnerService,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async settings(db: Database = this.db) {
    const [saved] = await db
      .select()
      .from(exportSettings)
      .where(eq(exportSettings.key, 'export'))
      .limit(1)
    return {
      ...exportSettingsSchema.parse({
        defaultDestination: saved?.defaultDestination ?? this.env.EXPORT_DEFAULT_DESTINATION,
      }),
      availableDestinations: this.adapters.map((adapter) => adapter.destination),
    }
  }

  async updateSettings(settings: ExportSettings, user: SessionUser, origin: RequestContext) {
    if (!this.adapters.some((adapter) => adapter.destination === settings.defaultDestination))
      throw new BadRequestException(`Destination ${settings.defaultDestination} is not configured`)
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('docflow-export-settings', 0))`,
      )
      const before = await this.settings(tx)
      await tx
        .insert(exportSettings)
        .values({ key: 'export', ...settings })
        .onConflictDoUpdate({ target: exportSettings.key, set: settings })
      await writeAudit(tx, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        action: 'export.settings_updated',
        objectType: 'export_settings',
        objectId: 'export',
        before,
        after: settings,
        result: 'success',
        ip: origin.ip,
        userAgent: origin.userAgent,
      })
      return this.settings(tx)
    })
  }

  async listForDocument(documentId: string, db: Database = this.db): Promise<ExportDto[]> {
    const rows = await db
      .select()
      .from(documentExports)
      .where(eq(documentExports.documentId, documentId))
      .orderBy(documentExports.exportKey)
    return rows.map((row) => this.toDto(row))
  }

  /** Download the saved export, including after later document changes. */
  async downloadJson(documentId: string, exportId: string): Promise<Buffer> {
    const [record] = await this.db
      .select({ payloadRef: documentExports.payloadRef })
      .from(documentExports)
      .where(
        and(
          eq(documentExports.id, exportId),
          eq(documentExports.documentId, documentId),
          eq(documentExports.destination, 'file_json'),
          eq(documentExports.status, 'succeeded'),
        ),
      )
      .limit(1)
    if (!record?.payloadRef) throw new NotFoundException('Completed JSON export not found')
    return this.storage.getBuffer(record.payloadRef)
  }

  /** Session lock serializes attempts across the durable prepare/send/finish commits. */
  async export(
    documentId: string,
    request: ExportRequest,
    user: SessionUser,
    origin: RequestContext,
  ): Promise<ExportDto> {
    const client = await this.pool.connect()
    client.on('error', () =>
      this.logger.warn('Export database connection interrupted; retry the saved export'),
    )
    try {
      await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [
        `docflow-export:${documentId}`,
      ])
      const db = drizzle(client, { schema: databaseSchema })
      return await this.exportLocked(db, documentId, request, user, {
        ...origin,
        correlationId: origin.correlationId ?? randomUUID(),
      })
    } finally {
      // Closing this dedicated connection releases its session lock even after
      // a failed SQL transaction or lost connection, without a lease timeout.
      client.release(true)
    }
  }

  private async exportLocked(
    db: Database,
    documentId: string,
    request: ExportRequest,
    user: SessionUser,
    origin: RequestContext,
  ): Promise<ExportDto> {
    const previous = request.exportKey ? await this.findByKey(db, request.exportKey) : undefined
    const destination =
      request.destination ?? previous?.destination ?? (await this.settings()).defaultDestination
    const exportKey = request.exportKey ?? `${documentId}:${destination}`
    const adapter = this.adapters.find((candidate) => candidate.destination === destination)

    const prepared = await db.transaction(async (tx) => {
      const document = await lockDocument(tx, documentId)
      if (!document) throw new NotFoundException('Document not found')
      // Different documents can race for the same user-supplied key. Check its
      // binding under one lock instead of surfacing a uniqueness error as 500.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`docflow-export-key:${exportKey}`}, 0))`,
      )
      let record = await this.findByKey(tx, exportKey)
      if (record && (record.documentId !== documentId || record.destination !== destination)) {
        throw new ConflictException(
          'Export key is already bound to a different document or destination',
        )
      }
      if (record?.status === 'succeeded') return { record, runId: null, status: document.status }
      if (!['approved', 'exported'].includes(document.status)) {
        throw new BadRequestException(
          `Only an approved document can be exported (current status: ${document.status})`,
        )
      }
      if (!document.documentType || document.documentType === 'unknown') {
        throw new BadRequestException('A document without a known type cannot be exported')
      }
      if (document.duplicateOfId)
        throw new BadRequestException('A duplicate of an accepted document cannot be exported')
      if (!adapter) throw new BadRequestException(`Destination ${destination} is not configured`)
      if (record && !record.canonicalPayload && record.attempts > 0) {
        // Old versions did not save the sent payload or an uncertain Sheets row.
        // Replaying guessed data could duplicate a write whose response was lost.
        throw new ConflictException(
          'Legacy export has no saved payload; reconcile the destination before creating a new export key',
        )
      }

      if (!record?.canonicalPayload) {
        const validation = await this.validation.runInTransaction(tx, documentId, {
          correlationId: origin.correlationId,
          actorId: user.id,
          actorType: 'user',
          route: false,
        })
        if (validation.decision.blockingCount > 0) {
          if (document.status !== 'exported') {
            await tx
              .update(documents)
              .set({ status: 'needs_review', statusReason: validation.decision.reasons.join('; ') })
              .where(eq(documents.id, documentId))
          }
          return new ConflictException(
            `Cannot export: ${validation.decision.blockingCount} unresolved blocking issue(s)`,
          )
        }
        const snapshot = {
          canonicalPayload: await this.buildCanonical(tx, document),
          mappingSnapshot: (await getDocumentSchema(tx, document))!.exportMapping,
        }
        if (record) {
          ;[record] = await tx
            .update(documentExports)
            .set(snapshot)
            .where(eq(documentExports.id, record.id))
            .returning()
        } else {
          ;[record] = await tx
            .insert(documentExports)
            .values({ documentId, destination, exportKey, ...snapshot })
            .returning()
        }
      }
      const runId = await startRun(tx, documentId, 'export', origin.correlationId!, record.id)
      ;[record] = await tx
        .update(documentExports)
        .set({ status: 'pending', errorCode: null, attempts: record.attempts + 1 })
        .where(eq(documentExports.id, record.id))
        .returning()
      await tx
        .update(documents)
        .set({ processingStep: 'export', processingRevision: document.processingRevision + 1 })
        .where(eq(documents.id, documentId))
      return { record, runId, status: document.status }
    })
    if (prepared instanceof ConflictException) throw prepared
    const { record, runId } = prepared
    if (runId === null) return this.toDto(record)

    await this.events.publish({
      type: 'document',
      documentId,
      status: prepared.status,
      step: 'export',
      state: 'running',
      at: new Date().toISOString(),
    })
    try {
      // Read-only discovery/allocation may fail. The payload and attempt already
      // exist, while target reservation commits before the first external write.
      const target =
        record.target ??
        (await db.transaction(async (tx) => {
          await lockDocument(tx, documentId)
          const reserved = await adapter!.reserve(tx, record.id)
          await tx
            .update(documentExports)
            .set({ target: reserved })
            .where(eq(documentExports.id, record.id))
          return reserved
        }))
      const payloadRef = await adapter!.send(
        record.canonicalPayload!,
        record.mappingSnapshot!,
        target,
      )
      const completed = await db.transaction(async (tx) => {
        await lockDocument(tx, documentId)
        const [saved] = await tx
          .update(documentExports)
          .set({ status: 'succeeded', payloadRef, errorCode: null, exportedAt: new Date() })
          .where(eq(documentExports.id, record.id))
          .returning()
        await tx
          .update(documents)
          .set({ status: 'exported', statusReason: null, processingStep: null })
          .where(eq(documents.id, documentId))
        await finishRun(tx, runId)
        await writeAudit(tx, {
          correlationId: origin.correlationId,
          actorType: 'user',
          actorId: user.id,
          action: 'document.exported',
          objectType: 'document',
          objectId: documentId,
          after: { destination, exportKey, payloadRef, attempts: record.attempts },
          result: 'success',
          ip: origin.ip,
          userAgent: origin.userAgent,
        })
        return saved
      })
      await this.events.publish({
        type: 'document',
        documentId,
        status: 'exported',
        step: 'export',
        state: 'succeeded',
        at: new Date().toISOString(),
      })
      return this.toDto(completed)
    } catch (error) {
      const code = error instanceof DestinationUnavailableError ? error.code : 'export_failed'
      const message = error instanceof Error ? error.message : String(error)
      // If the connection died, this transaction also fails: Pending and its
      // Running log survive and the next manual request replays the same target.
      const failed = await db.transaction(async (tx) => {
        const document = await lockDocument(tx, documentId)
        const [saved] = await tx
          .update(documentExports)
          .set({ status: 'failed', errorCode: code })
          .where(eq(documentExports.id, record.id))
          .returning()
        await failRun(tx, runId, code, message)
        await writeAudit(tx, {
          correlationId: origin.correlationId,
          actorType: 'user',
          actorId: user.id,
          action: 'document.export_failed',
          objectType: 'document',
          objectId: documentId,
          after: { destination, exportKey, errorCode: code, message, attempts: record.attempts },
          result: 'failure',
          ip: origin.ip,
          userAgent: origin.userAgent,
        })
        return { saved, status: document?.status }
      })
      await this.events.publish({
        type: 'document',
        documentId,
        status: failed.status,
        step: 'export',
        state: 'failed',
        at: new Date().toISOString(),
      })
      this.logger.warn(`Export ${exportKey} failed: ${message}`)
      return this.toDto(failed.saved)
    }
  }

  private async findByKey(db: Database, exportKey: string) {
    const [row] = await db
      .select()
      .from(documentExports)
      .where(eq(documentExports.exportKey, exportKey))
      .limit(1)
    return row
  }

  private async buildCanonical(db: Database, document: typeof documents.$inferSelect) {
    if (!document.checksum || !document.storageKey)
      throw new BadRequestException('The original was not stored')
    const schema = await getDocumentSchema(db, document)

    const fieldRows = await db
      .select()
      .from(fields)
      .where(eq(fields.documentId, document.id))
      .orderBy(fields.name)

    const warnings = await db
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
      destination: row.destination as ExportDto['destination'],
      exportKey: row.exportKey,
      status: row.status,
      payloadRef: row.payloadRef,
      errorCode: row.errorCode,
      attempts: row.attempts,
      exportedAt: row.exportedAt ? row.exportedAt.toISOString() : null,
    }
  }
}
