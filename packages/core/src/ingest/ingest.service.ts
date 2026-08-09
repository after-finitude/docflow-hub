import { decideIngest, type ActorType, type SourceType } from '@docflow/shared'
import { DEFAULT_TENANT_ID } from '@docflow/shared'
import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { Queue } from 'bullmq'
import { and, desc, eq } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { writeAudit } from '../db/audit'
import { DB, type Database } from '../db/db.module'
import { documents } from '../db/schema'
import { finishRun, startRun } from '../db/workflow'
import { DocumentEventsService } from '../events/document-events.service'
import { QUEUE } from '../queue/queues'
import { originalKey } from '../storage/keys'
import { StorageService } from '../storage/storage.service'

export interface IngestInput {
  buffer: Buffer
  filename: string
  mimeType: string
  sizeBytes: number
  sourceType: SourceType
  /** Путь или id файла в источнике: по нему определяются версии (ТЗ 6.9). */
  sourcePath?: string | null
  sourceMessageId?: string | null
  actorType: ActorType
  actorId?: string | null
  auditAction: string
  correlationId: string
  ip?: string | null
  userAgent?: string | null
}

export interface IngestResult {
  documentId: string | null
  action: 'created' | 'versioned' | 'skipped'
}

/**
 * Приём файла (ТЗ 6.1): checksum, связь дубликатов, версии по пути источника,
 * запись в хранилище и постановка в pipeline.
 *
 * Общий код загрузки через интерфейс и синхронизации источника: расхождение
 * этих двух путей означало бы, что дубликаты и версии работают по-разному
 * в зависимости от того, откуда пришёл файл.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name)

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly events: DocumentEventsService,
    @InjectQueue(QUEUE.PREPROCESS) private readonly preprocessQueue: Queue,
  ) {}

  async ingest(input: IngestInput): Promise<IngestResult> {
    const checksum = createHash('sha256').update(input.buffer).digest('hex')

    const current = input.sourcePath
      ? await this.currentVersion(input.sourceType, input.sourcePath)
      : null
    const decision = decideIngest(current, checksum)
    if (decision.action === 'skip') return { documentId: current?.id ?? null, action: 'skipped' }

    const storageKey = originalKey(randomUUID(), input.mimeType)

    // Файл кладётся в хранилище до создания записи: строка документа никогда
    // не должна указывать на отсутствующий объект. Осиротевший объект при
    // отказе вставки безвреден и вычищается retention-задачей.
    await this.storage.put(storageKey, input.buffer, input.mimeType)

    // Дубликат по checksum: документ принимается, но связывается с оригиналом
    // и повторно не экспортируется (ТЗ §10). Проверка общая для всех
    // источников — файл, пришедший с Диска, может дублировать загруженный.
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
        sourceType: input.sourceType,
        sourcePath: input.sourcePath ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        originalFilename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        checksum,
        storageKey,
        status: 'received',
        versionNumber: decision.versionNumber,
        duplicateOfId: duplicateOf?.id ?? null,
      })
      .returning({ id: documents.id })

    if (decision.action === 'version' && current) {
      // Прежняя версия сохраняется, но перестаёт быть актуальной (ТЗ 6.9).
      // Обработка, уже запущенная для неё, доводится до конца: она работает
      // со своей копией файла в хранилище (ТЗ §10).
      await this.db
        .update(documents)
        .set({ isActive: false, deactivatedAt: new Date() })
        .where(eq(documents.id, current.id))
    }

    await writeAudit(this.db, {
      correlationId: input.correlationId,
      actorType: input.actorType,
      actorId: input.actorId ?? undefined,
      action: input.auditAction,
      objectType: 'document',
      objectId: created.id,
      after: {
        filename: input.filename,
        sizeBytes: input.sizeBytes,
        checksum,
        sourceType: input.sourceType,
        sourcePath: input.sourcePath ?? null,
        versionNumber: decision.versionNumber,
        supersedes: decision.action === 'version' ? current?.id : undefined,
      },
      result: 'success',
      ip: input.ip ?? undefined,
      userAgent: input.userAgent ?? undefined,
    })

    // Приём — первый этап журнала выполнения (ТЗ 5.3): он завершён в момент,
    // когда файл сохранён и документ создан.
    const runId = await startRun(this.db, created.id, 'ingestion', input.correlationId)
    await finishRun(this.db, runId)

    await this.preprocessQueue.add('preprocess', {
      documentId: created.id,
      correlationId: input.correlationId,
    })
    await this.events.publish({
      type: 'document',
      documentId: created.id,
      status: 'received',
      step: 'ingestion',
      state: 'succeeded',
      at: new Date().toISOString(),
    })

    this.logger.log(
      `Принят документ ${created.id} (${input.sourceType}), версия ${decision.versionNumber}`,
    )
    return {
      documentId: created.id,
      action: decision.action === 'version' ? 'versioned' : 'created',
    }
  }

  /** Актуальная версия по пути источника: она же основа для сравнения хеша. */
  private async currentVersion(
    sourceType: SourceType,
    sourcePath: string,
  ): Promise<{ id: string; checksum: string; versionNumber: number } | null> {
    const [row] = await this.db
      .select({
        id: documents.id,
        checksum: documents.checksum,
        versionNumber: documents.versionNumber,
      })
      .from(documents)
      .where(
        and(
          eq(documents.sourceType, sourceType),
          eq(documents.sourcePath, sourcePath),
          eq(documents.isActive, true),
        ),
      )
      .orderBy(desc(documents.versionNumber))
      .limit(1)
    return row ?? null
  }
}
