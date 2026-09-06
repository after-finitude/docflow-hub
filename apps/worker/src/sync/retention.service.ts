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

/** Prefix containing all document files (packages/core/src/storage/keys.ts). */
const DOCUMENTS_PREFIX = 'documents/'

/**
 * Retention and deletion (spec 6.9, §11).
 *
 * Two independent cleanups: permanently delete documents inactive longer than
 * RETENTION_DAYS with their files, and delete unreferenced storage objects by TTL.
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
   * Permanent deletion by retention policy. Measure age from deactivation,
   * not ingest, so an old document removed from the source yesterday is not
   * deleted immediately.
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
      if (document.storageKey) await this.storage.removePrefix(documentPrefix(document.storageKey))

      // Clear duplicate links to the original being deleted; the duplicate
      // remains as a regular document.
      await this.db
        .update(documents)
        .set({ duplicateOfId: null })
        .where(eq(documents.duplicateOfId, document.id))

      // Pages, fields, issues, exports, and execution entries cascade. Audit
      // events intentionally outlive the document in their immutable table (spec §11).
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

    if (expired.length) this.logger.log(`Deleted by retention policy: ${expired.length}`)
    return expired.length
  }

  /**
   * Objects without a document appear when storage succeeds but row insertion
   * fails. This ordering ensures a document never references a missing object.
   */
  private async removeOrphans(now: Date): Promise<number> {
    const threshold = new Date(now.getTime() - this.env.ORPHAN_TTL_HOURS * 3_600_000)
    const objects = (await this.storage.list(DOCUMENTS_PREFIX)).filter(
      (object) => object.lastModified < threshold,
    )
    if (objects.length === 0) return 0

    const prefixes = [...new Set(objects.map((object) => documentPrefix(object.key)))]
    const referenced = new Set(
      (await this.db.select({ storageKey: documents.storageKey }).from(documents)).flatMap((row) =>
        row.storageKey ? [documentPrefix(row.storageKey)] : [],
      ),
    )

    let removed = 0
    for (const prefix of prefixes) {
      if (referenced.has(prefix)) continue
      removed += await this.storage.removePrefix(prefix)
    }

    if (removed) this.logger.log(`Deleted unreferenced objects: ${removed}`)
    return removed
  }
}
