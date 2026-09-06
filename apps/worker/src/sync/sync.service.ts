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
 * Secondary-source sync (spec 6.1, 6.9): ingest new files, version changed
 * files, and mark removed files inactive.
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
    if (!provider) throw new Error('Source is not configured')

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
          `File ${file.sourcePath} was not ingested: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    for (const path of deletedPaths) {
      summary.deactivated += await this.deactivate(provider, path, correlationId)
    }

    // Advance the cursor only after a failure-free pass; otherwise a failed
    // download would never appear again. Reprocessing is safe because ingest is
    // idempotent by path and content.
    if (summary.failed === 0) {
      await writeCursor(this.db, provider.name, listing.cursor)
    } else {
      await writeCursor(this.db, provider.name, cursor, `Files not ingested: ${summary.failed}`)
    }

    this.logger.log(
      `Sync ${provider.name}: ${summary.created} new, ${summary.versioned} versioned, ` +
        `${summary.skipped} unchanged, ${summary.deactivated} removed, ${summary.failed} failed`,
    )
    return summary
  }

  /** Active versions of ingested source files used as the snapshot baseline. */
  private async knownFiles(
    provider: SourceProvider,
  ): Promise<{ sourcePath: string; checksum: string }[]> {
    const rows = await this.db
      .select({ sourcePath: documents.sourcePath, checksum: documents.checksum })
      .from(documents)
      .where(and(eq(documents.sourceType, provider.sourceType), eq(documents.isActive, true)))

    return rows.flatMap((row) =>
      row.sourcePath && row.checksum
        ? [{ sourcePath: row.sourcePath, checksum: row.checksum }]
        : [],
    )
  }

  /**
   * Source deletion marks a document inactive rather than deleting it. The
   * retention job performs permanent deletion (spec 6.9), preserving review
   * and decision history until then.
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
        after: { reason: 'File removed from source', sourcePath },
        result: 'success',
      })
    }
    return affected.length
  }
}
