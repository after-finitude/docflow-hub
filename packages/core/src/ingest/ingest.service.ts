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
  /** Source path or file ID used to identify versions (spec 6.9). */
  sourcePath?: string | null
  sourceMessageId?: string | null
  actorType: ActorType
  actorId?: string | null
  auditAction: string
  correlationId: string
  ip?: string | null
  userAgent?: string | null
  /**
   * Document replaced by this file (spec §10). Explicitly identifies the prior
   * version when no source path exists.
   */
  replaces?: { id: string; versionNumber: number } | null
}

export interface IngestResult {
  documentId: string | null
  action: 'created' | 'versioned' | 'skipped'
}

/**
 * File ingest (spec 6.1): checksum, duplicate linkage, source-path versions,
 * storage write, and pipeline enqueue.
 *
 * UI upload and source sync share this code so duplicates and versions behave
 * identically regardless of origin.
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

    // Replacement identifies its predecessor directly; source files find it by
    // path. Matching content means nothing changed in either case.
    const current = input.replaces
      ? { ...input.replaces, checksum: await this.checksumOf(input.replaces.id) }
      : input.sourcePath
        ? await this.currentVersion(input.sourceType, input.sourcePath)
        : null
    const decision = decideIngest(current, checksum)
    if (decision.action === 'skip') return { documentId: current?.id ?? null, action: 'skipped' }

    const storageKey = originalKey(randomUUID(), input.mimeType)

    // Store the file before inserting its row so a document never references a
    // missing object. Retention cleans up an orphan if insertion fails.
    await this.storage.put(storageKey, input.buffer, input.mimeType)

    // Accept checksum duplicates but link them to the original and do not export
    // again (spec §10). Check across all sources.
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
        previousVersionId: decision.action === 'version' ? (current?.id ?? null) : null,
        duplicateOfId: duplicateOf?.id ?? null,
      })
      .returning({ id: documents.id })

    if (decision.action === 'version' && current) {
      // Preserve the old version as inactive (spec 6.9). Already-started
      // processing finishes against its own stored copy (spec §10).
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

    // Ingest is the first execution-log stage (spec 5.3), complete when storage
    // and document creation succeed.
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
      `Ingested document ${created.id} (${input.sourceType}), version ${decision.versionNumber}`,
    )
    return {
      documentId: created.id,
      action: decision.action === 'version' ? 'versioned' : 'created',
    }
  }

  private async checksumOf(documentId: string): Promise<string> {
    const [row] = await this.db
      .select({ checksum: documents.checksum })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)
    return row?.checksum ?? ''
  }

  /** Active version by source path, also the checksum comparison baseline. */
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
