import {
  DB,
  DocumentEventsService,
  QUEUE,
  StorageService,
  ValidationRunnerService,
  documents,
  fields,
  getActiveSchema,
  originalKey,
  pages,
  validationIssues,
  workflowRuns,
  writeAudit,
  type Database,
} from '@docflow/core'
import {
  DEFAULT_TENANT_ID,
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
import { createHash, randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { RequestContext } from '../auth/decorators'
import { ExportService } from '../export/export.service'
import type { UploadedDocument } from './uploaded-document'

/** Поля, вычисляемые подзапросами: до этапов 4–5 они пустые, но форма ответа уже финальная. */
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
  receivedAt: documents.receivedAt,
  minCriticalConfidence: sql<number | null>`(
    select min(${fields.confidence}) from ${fields}
    where ${fields.documentId} = ${documents.id} and ${fields.isCritical}
  )`.as('min_critical_confidence'),
  blockingIssues: sql<number>`(
    select count(*)::int from ${validationIssues}
    where ${validationIssues.documentId} = ${documents.id}
      and ${validationIssues.severity} = 'blocking'
      and ${validationIssues.resolvedAt} is null
  )`.as('blocking_issues'),
  warningIssues: sql<number>`(
    select count(*)::int from ${validationIssues}
    where ${validationIssues.documentId} = ${documents.id}
      and ${validationIssues.severity} = 'warning'
      and ${validationIssues.resolvedAt} is null
  )`.as('warning_issues'),
  currentStep: sql<WorkflowStep | null>`(
    select ${workflowRuns.step} from ${workflowRuns}
    where ${workflowRuns.documentId} = ${documents.id}
    order by ${workflowRuns.startedAt} desc nulls last limit 1
  )`.as('current_step'),
  currentStepState: sql<WorkflowState | null>`(
    select ${workflowRuns.state} from ${workflowRuns}
    where ${workflowRuns.documentId} = ${documents.id}
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
    private readonly exports: ExportService,
    @InjectQueue(QUEUE.PREPROCESS) private readonly preprocessQueue: Queue,
    @InjectQueue(QUEUE.EXTRACT) private readonly extractQueue: Queue,
  ) {}

  async upload(
    file: UploadedDocument,
    user: SessionUser,
    origin: RequestContext,
  ): Promise<DocumentListItem> {
    const checksum = createHash('sha256').update(file.buffer).digest('hex')
    const storageKey = originalKey(randomUUID(), file.mimetype)

    // Файл кладётся в хранилище до создания записи: строка документа никогда
    // не должна указывать на отсутствующий объект. Осиротевший объект при
    // отказе вставки безвреден и вычищается retention-задачей.
    await this.storage.put(storageKey, file.buffer, file.mimetype)

    // Дубликат по checksum: документ принимается, но связывается с оригиналом
    // и повторно не экспортируется (ТЗ §10).
    const [duplicateOf] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.checksum, checksum), eq(documents.isActive, true)))
      .orderBy(documents.receivedAt)
      .limit(1)

    const [created] = await this.db
      .insert(documents)
      .values({
        tenantId: DEFAULT_TENANT_ID,
        sourceType: 'upload',
        originalFilename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        checksum,
        storageKey,
        status: 'received',
        duplicateOfId: duplicateOf?.id ?? null,
      })
      .returning({ id: documents.id })

    await writeAudit(this.db, {
      correlationId: origin.correlationId,
      actorType: 'user',
      actorId: user.id,
      action: 'document.upload',
      objectType: 'document',
      objectId: created.id,
      after: { filename: file.originalname, sizeBytes: file.size, checksum },
      result: 'success',
      ip: origin.ip,
      userAgent: origin.userAgent,
    })

    await this.enqueuePreprocess(created.id, origin.correlationId ?? randomUUID())
    return this.findOne(created.id)
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

    if (!row) throw new NotFoundException('Документ не найден')

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
      // Approve заблокирован при любой нерешённой blocking-ошибке (ТЗ §9).
      canApprove: base.status === 'needs_review' && base.blockingIssues === 0,
    }
  }

  /**
   * Правка значения оператором (ТЗ 5.2, §9). Сохраняет before/after в журнал,
   * синхронно перезапускает валидацию и возвращает документ с обновлённым
   * списком проблем и доступностью Approve.
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
    if (!document) throw new NotFoundException('Документ не найден')
    if (document.status === 'processing') {
      throw new BadRequestException('Документ ещё обрабатывается')
    }
    if (document.status === 'exported') {
      throw new BadRequestException('Выгруженный документ не редактируется')
    }

    const [field] = await this.db
      .select()
      .from(fields)
      .where(and(eq(fields.documentId, id), eq(fields.name, name)))
      .limit(1)
    if (!field) throw new NotFoundException(`Поле ${name} не найдено`)

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
        // Значение введено человеком: сигналы извлечения к нему неприменимы,
        // поэтому они очищаются, а перевалидация оставит уверенность как есть.
        confidenceSignals: null,
        confidence: value === null ? null : 1,
        confidenceReason:
          value === null ? 'Значение удалено оператором' : 'Значение исправлено оператором',
      })
      .where(eq(fields.id, field.id))

    await this.validation.run(id, {
      correlationId: origin.correlationId,
      actorType: 'user',
      actorId: user.id,
      // Правка не подтверждает документ за оператора — Approve нажимает он сам.
      autoApprove: false,
    })

    return this.findOne(id)
  }

  /** Подтверждение оператором (ТЗ 5.2). Проверка blocking выполняется на сервере. */
  async approve(id: string, user: SessionUser, origin: RequestContext): Promise<DocumentDetail> {
    const [document] = await this.db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!document) throw new NotFoundException('Документ не найден')
    if (document.status !== 'needs_review') {
      throw new BadRequestException(
        `Документ в статусе ${document.status} не требует подтверждения`,
      )
    }

    // Состояние проблем перепроверяется здесь, а не берётся из ответа клиента:
    // блокировка кнопки в интерфейсе — удобство, а не защита (ТЗ §9).
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
      throw new ConflictException(
        `Подтверждение невозможно: нерешённых блокирующих ошибок — ${blocking}`,
      )
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

  /** Отклонение с причиной из списка и комментарием (ТЗ 5.2). */
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
    if (!document) throw new NotFoundException('Документ не найден')
    if (document.status === 'exported') {
      throw new BadRequestException('Выгруженный документ не отклоняется')
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

  /** Смена типа вручную: перезапускает извлечение по новой схеме (ТЗ 6.3, §8). */
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

    if (!row) throw new NotFoundException('Документ не найден')
    if (row.status === 'processing') throw new BadRequestException('Документ ещё обрабатывается')

    const [{ pagesCount }] = await this.db
      .select({ pagesCount: sql<number>`count(*)::int` })
      .from(pages)
      .where(eq(pages.documentId, id))
    if (!pagesCount) {
      throw new BadRequestException('Документ ещё не распознан: смена типа недоступна')
    }

    await this.db
      .update(documents)
      // Ручной выбор — достоверность максимальная (ТЗ 6.3).
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

    // Метки и обязательность — косметика из активной схемы типа; поля документа
    // при этом остаются привязанными к версии схемы, по которой извлекались.
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

  /** Постраничный OCR-результат: текст, блоки с координатами, уверенность (ТЗ 6.2, §8). */
  async pages(id: string): Promise<DocumentPage[]> {
    const [exists_] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!exists_) throw new NotFoundException('Документ не найден')

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

  /** Исходные данные для рендера страницы просмотрщиком. */
  async fileLocation(id: string): Promise<{ storageKey: string; mimeType: string }> {
    const [row] = await this.db
      .select({ storageKey: documents.storageKey, mimeType: documents.mimeType })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!row) throw new NotFoundException('Документ не найден')
    return row
  }

  /** Миниатюра отдаётся через API, а не подписанной ссылкой: доступ проверяет guard. */
  async thumbnail(id: string): Promise<Readable> {
    const [row] = await this.db
      .select({ key: documents.thumbnailKey })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row) throw new NotFoundException('Документ не найден')
    if (!row.key) throw new NotFoundException('Миниатюра ещё не готова')
    return this.storage.getStream(row.key)
  }

  async signedFileUrl(id: string): Promise<string> {
    const [row] = await this.db
      .select({ key: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row) throw new NotFoundException('Документ не найден')
    return this.storage.signedUrl(row.key)
  }

  async reprocess(id: string, user: SessionUser, origin: RequestContext): Promise<DocumentDetail> {
    const [row] = await this.db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row) throw new NotFoundException('Документ не найден')
    if (row.status === 'processing') {
      throw new BadRequestException('Документ уже обрабатывается')
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
      currentStep: value.currentStep,
      currentStepState: value.currentStepState,
      receivedAt: value.receivedAt.toISOString(),
    }
  }
}
