import { DB, IngestService, StorageService, documents, type Database } from '@docflow/core'
import {
  canPerform,
  isInFlight,
  type OversizedUploadRequest,
  type DocumentListItem,
  type SessionUser,
} from '@docflow/shared'
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { RequestContext } from '../auth/decorators'
import { DocumentQueryService } from './document-query.service'
import type { UploadedDocument } from './uploaded-document'

/** Originals: upload, replacement, oversized rejection and file delivery. */
@Injectable()
export class DocumentFilesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly ingest: IngestService,
    private readonly query: DocumentQueryService,
  ) {}

  async rejectOversized(
    body: Omit<OversizedUploadRequest, 'sizeBytes'> & { sizeBytes: number | null },
    user: SessionUser,
    origin: RequestContext,
  ): Promise<DocumentListItem> {
    const id = await this.ingest.rejectOversized({
      ...body,
      actorType: 'user',
      actorId: user.id,
      correlationId: origin.correlationId ?? randomUUID(),
      ip: origin.ip,
      userAgent: origin.userAgent,
    })
    return this.query.findOne(id)
  }

  async upload(
    file: UploadedDocument,
    user: SessionUser,
    origin: RequestContext,
  ): Promise<DocumentListItem> {
    // Upload and source sync share ingest so checksums, duplicates, and versions
    // do not depend on how a file entered the system.
    const result = await this.ingest.ingest({
      buffer: file.buffer,
      filename: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      sourceType: 'upload',
      actorType: 'user',
      actorId: user.id,
      auditAction: 'document.upload',
      correlationId: origin.correlationId ?? randomUUID(),
      ip: origin.ip,
      userAgent: origin.userAgent,
    })

    // UI uploads have no source path, so ingest always creates a document and
    // the skipped branch is unreachable.
    return this.query.findOne(result.documentId!)
  }

  /**
   * Original replacement (spec §10). Do not overwrite the file: create a new
   * version and retain the inactive previous version with its decision history.
   */
  async replaceFile(
    id: string,
    file: UploadedDocument,
    user: SessionUser,
    origin: RequestContext,
  ): Promise<DocumentListItem> {
    const [document] = await this.db
      .select({
        id: documents.id,
        status: documents.status,
        processingStep: documents.processingStep,
        sourceType: documents.sourceType,
        versionNumber: documents.versionNumber,
        isActive: documents.isActive,
        checksum: documents.checksum,
      })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!document) throw new NotFoundException('Document not found')

    if (document.sourceType !== 'upload') {
      // Otherwise the next sync would restore the source contents and silently
      // discard the operator's replacement.
      throw new BadRequestException(
        'This document came from a source; replace the file at the source',
      )
    }
    if (!document.isActive) {
      throw new BadRequestException('Document is inactive; only the latest version can be replaced')
    }
    if (!canPerform('replaceFile', document.status)) {
      throw new BadRequestException(
        isInFlight(document.status)
          ? 'Document is still processing'
          : `A document with status ${document.status} cannot be replaced`,
      )
    }
    if (document.processingStep === 'export') {
      throw new ConflictException('Retry the saved export before changing this document')
    }

    const result = await this.ingest.ingest({
      buffer: file.buffer,
      filename: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      sourceType: 'upload',
      actorType: 'user',
      actorId: user.id,
      auditAction: 'document.file_replaced',
      correlationId: origin.correlationId ?? randomUUID(),
      ip: origin.ip,
      userAgent: origin.userAgent,
      replaces: { id: document.id, versionNumber: document.versionNumber },
    })

    if (result.action === 'skipped') {
      throw new BadRequestException('The same file was uploaded; there is nothing to replace')
    }
    return this.query.findOne(result.documentId!)
  }

  /** Source data for rendering a page in the viewer. */
  async fileLocation(id: string): Promise<{ storageKey: string; mimeType: string }> {
    const [row] = await this.db
      .select({ storageKey: documents.storageKey, mimeType: documents.mimeType })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!row) throw new NotFoundException('Document not found')
    if (!row.storageKey) throw new NotFoundException('The original was not stored')
    return { ...row, storageKey: row.storageKey }
  }

  /** Serve thumbnails through the guarded API rather than a signed URL. */
  async thumbnail(id: string): Promise<Readable> {
    const [row] = await this.db
      .select({ key: documents.thumbnailKey })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row) throw new NotFoundException('Document not found')
    if (!row.key) throw new NotFoundException('Thumbnail is not ready yet')
    return this.storage.getStream(row.key)
  }

  async signedFileUrl(id: string): Promise<string> {
    const [row] = await this.db
      .select({ key: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row) throw new NotFoundException('Document not found')
    if (!row.key) throw new NotFoundException('The original was not stored')
    return this.storage.signedUrl(row.key)
  }
}
