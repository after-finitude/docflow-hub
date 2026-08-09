import {
  DB,
  IngestService,
  documents,
  readCursor,
  writeAudit,
  writeCursor,
  type Database,
} from '@docflow/core'
import { diffSnapshot, type SourceFile } from '@docflow/shared'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { SOURCE_PROVIDER, type SourceProvider } from './source-provider'

export interface SyncSummary {
  created: number
  versioned: number
  skipped: number
  deactivated: number
  failed: number
}

/**
 * Синхронизация второго источника (ТЗ 6.1, 6.9): новые файлы принимаются,
 * изменённые становятся новой версией, исчезнувшие помечаются неактивными.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name)

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ingest: IngestService,
    @Optional() @Inject(SOURCE_PROVIDER) private readonly provider: SourceProvider | null,
  ) {}

  get enabled(): boolean {
    return this.provider !== null
  }

  async run(correlationId: string): Promise<SyncSummary> {
    const provider = this.provider
    if (!provider) throw new Error('Источник не настроен')

    const summary: SyncSummary = {
      created: 0,
      versioned: 0,
      skipped: 0,
      deactivated: 0,
      failed: 0,
    }

    const cursor = await readCursor(this.db, provider.name)
    const listing = await provider.list(cursor)

    let upserted: SourceFile[]
    let deletedPaths: string[]
    if (listing.mode === 'snapshot') {
      const diff = diffSnapshot(listing.files, await this.knownFiles(provider))
      upserted = diff.upserted
      deletedPaths = diff.deletedPaths
    } else {
      upserted = listing.files
      deletedPaths = listing.deletedPaths
    }

    for (const file of upserted) {
      try {
        const buffer = await provider.download(file)
        const result = await this.ingest.ingest({
          buffer,
          filename: file.name,
          mimeType: file.mimeType,
          sizeBytes: buffer.byteLength,
          sourceType: provider.sourceType,
          sourcePath: file.sourcePath,
          actorType: 'system',
          auditAction: 'document.synced',
          correlationId,
        })
        if (result.action === 'created') summary.created += 1
        if (result.action === 'versioned') summary.versioned += 1
        if (result.action === 'skipped') summary.skipped += 1
      } catch (error) {
        summary.failed += 1
        this.logger.error(
          `Файл ${file.sourcePath} не принят: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    for (const path of deletedPaths) {
      summary.deactivated += await this.deactivate(provider, path, correlationId)
    }

    // Курсор двигается только после прохода без отказов: иначе файл, который
    // не удалось скачать, не вернулся бы в приращение никогда. Повторная
    // обработка безопасна — приём идемпотентен по паре путь+содержимое.
    if (summary.failed === 0) {
      await writeCursor(this.db, provider.name, listing.cursor)
    } else {
      await writeCursor(this.db, provider.name, cursor, `Не принято файлов: ${summary.failed}`)
    }

    this.logger.log(
      `Синхронизация ${provider.name}: новых ${summary.created}, версий ${summary.versioned}, ` +
        `без изменений ${summary.skipped}, удалено ${summary.deactivated}, отказов ${summary.failed}`,
    )
    return summary
  }

  /** Актуальные версии уже принятых файлов источника — основа сравнения снимка. */
  private async knownFiles(
    provider: SourceProvider,
  ): Promise<{ sourcePath: string; checksum: string }[]> {
    const rows = await this.db
      .select({ sourcePath: documents.sourcePath, checksum: documents.checksum })
      .from(documents)
      .where(and(eq(documents.sourceType, provider.sourceType), eq(documents.isActive, true)))

    return rows.flatMap((row) =>
      row.sourcePath ? [{ sourcePath: row.sourcePath, checksum: row.checksum }] : [],
    )
  }

  /**
   * Удаление в источнике не стирает документ: он помечается неактивным,
   * физическое удаление выполняет retention-задача (ТЗ 6.9). История
   * проверок и решений по нему остаётся доступной.
   */
  private async deactivate(
    provider: SourceProvider,
    sourcePath: string,
    correlationId: string,
  ): Promise<number> {
    const affected = await this.db
      .update(documents)
      .set({ isActive: false, deactivatedAt: new Date() })
      .where(
        and(
          eq(documents.sourceType, provider.sourceType),
          eq(documents.sourcePath, sourcePath),
          eq(documents.isActive, true),
        ),
      )
      .returning({ id: documents.id })

    for (const row of affected) {
      await writeAudit(this.db, {
        correlationId,
        actorType: 'system',
        action: 'document.deactivated',
        objectType: 'document',
        objectId: row.id,
        after: { reason: 'Файл удалён в источнике', sourcePath },
        result: 'success',
      })
    }
    return affected.length
  }
}
