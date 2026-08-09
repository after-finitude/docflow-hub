import {
  DB,
  ENV,
  StorageService,
  documentPrefix,
  documents,
  writeAudit,
  type Database,
  type Env,
} from '@docflow/core'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq, isNotNull, lt } from 'drizzle-orm'

export interface RetentionSummary {
  purgedDocuments: number
  removedObjects: number
}

/** Префикс, под которым лежат все файлы документов (packages/core/src/storage/keys.ts). */
const DOCUMENTS_PREFIX = 'documents/'

/**
 * Хранение и удаление (ТЗ 6.9, §11).
 *
 * Две независимые уборки: документы, потерявшие актуальность дольше
 * RETENTION_DAYS назад, удаляются физически вместе с файлами; объекты
 * хранилища, на которые не ссылается ни один документ, удаляются по TTL.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name)

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly storage: StorageService,
  ) {}

  async run(correlationId: string, now = new Date()): Promise<RetentionSummary> {
    return {
      purgedDocuments: await this.purgeExpired(correlationId, now),
      removedObjects: await this.removeOrphans(now),
    }
  }

  /**
   * Физическое удаление по retention policy. Срок считается от момента
   * потери актуальности, а не от приёма: иначе документ, удалённый в
   * источнике вчера, но принятый год назад, стирался бы немедленно.
   */
  private async purgeExpired(correlationId: string, now: Date): Promise<number> {
    const threshold = new Date(now.getTime() - this.env.RETENTION_DAYS * 86_400_000)

    const expired = await this.db
      .select({
        id: documents.id,
        storageKey: documents.storageKey,
        filename: documents.originalFilename,
      })
      .from(documents)
      .where(
        and(
          eq(documents.isActive, false),
          isNotNull(documents.deactivatedAt),
          lt(documents.deactivatedAt, threshold),
        ),
      )

    for (const document of expired) {
      await this.storage.removePrefix(documentPrefix(document.storageKey))

      // Ссылка дубликата на удаляемый оригинал снимается: связь исчезает
      // вместе с оригиналом, но сам дубликат остаётся обычным документом.
      await this.db
        .update(documents)
        .set({ duplicateOfId: null })
        .where(eq(documents.duplicateOfId, document.id))

      // Страницы, поля, проблемы, выгрузки и записи журнала выполнения
      // удаляются каскадом; audit_events переживают документ намеренно —
      // таблица неизменяема (ТЗ §11).
      await this.db.delete(documents).where(eq(documents.id, document.id))

      await writeAudit(this.db, {
        correlationId,
        actorType: 'system',
        action: 'document.purged',
        objectType: 'document',
        objectId: document.id,
        before: { filename: document.filename, storageKey: document.storageKey },
        after: { retentionDays: this.env.RETENTION_DAYS },
        result: 'success',
      })
    }

    if (expired.length) this.logger.log(`Удалено по retention: ${expired.length}`)
    return expired.length
  }

  /**
   * Объекты без документа. Появляются, когда файл записан в хранилище,
   * а вставка строки не удалась — запись идёт в таком порядке намеренно,
   * чтобы документ никогда не ссылался на отсутствующий объект.
   */
  private async removeOrphans(now: Date): Promise<number> {
    const threshold = new Date(now.getTime() - this.env.ORPHAN_TTL_HOURS * 3_600_000)
    const objects = (await this.storage.list(DOCUMENTS_PREFIX)).filter(
      (object) => object.lastModified < threshold,
    )
    if (objects.length === 0) return 0

    const prefixes = [...new Set(objects.map((object) => documentPrefix(object.key)))]
    const referenced = new Set(
      (await this.db.select({ storageKey: documents.storageKey }).from(documents)).map((row) =>
        documentPrefix(row.storageKey),
      ),
    )

    let removed = 0
    for (const prefix of prefixes) {
      if (referenced.has(prefix)) continue
      removed += await this.storage.removePrefix(prefix)
    }

    if (removed) this.logger.log(`Удалено объектов без документа: ${removed}`)
    return removed
  }
}
