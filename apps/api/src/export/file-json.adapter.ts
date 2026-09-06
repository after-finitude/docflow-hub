import { StorageService, type Database } from '@docflow/core'
import type { CanonicalDocument, ExportDestination, ExportTarget } from '@docflow/shared'
import { Injectable } from '@nestjs/common'
import { DestinationUnavailableError, type ExportAdapter } from './export-adapter'

/**
 * Export canonical JSON to object storage (spec 6.8). No mapping is applied
 * because the canonical representation is the file content.
 */
@Injectable()
export class FileJsonAdapter implements ExportAdapter {
  readonly destination: ExportDestination = 'file_json'

  constructor(private readonly storage: StorageService) {}

  async reserve(_db: Database, exportId: string): Promise<ExportTarget> {
    // The immutable database UUID is collision-free even when user keys contain
    // punctuation or Unicode. Successful legacy files retain their saved paths.
    return { kind: 'file_json', objectKey: `exports/${exportId}.json` }
  }

  async send(
    canonical: CanonicalDocument,
    _mapping: unknown,
    target: ExportTarget,
  ): Promise<string> {
    if (target.kind !== 'file_json') throw new Error('Invalid JSON export target')
    try {
      await this.storage.put(
        target.objectKey,
        Buffer.from(JSON.stringify(canonical, null, 2)),
        'application/json',
      )
    } catch (error) {
      throw new DestinationUnavailableError(
        'storage_unavailable',
        `Storage unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return target.objectKey
  }
}
