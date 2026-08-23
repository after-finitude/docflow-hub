import { StorageService } from '@docflow/core'
import type { CanonicalDocument, ExportDestination } from '@docflow/shared'
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

  async send(canonical: CanonicalDocument, _mapping: unknown, exportKey: string): Promise<string> {
    // Include the idempotency key in the object name so retries overwrite the
    // same file instead of creating copies.
    const key = `exports/${sanitize(exportKey)}.json`
    try {
      await this.storage.put(
        key,
        Buffer.from(JSON.stringify(canonical, null, 2)),
        'application/json',
      )
    } catch (error) {
      throw new DestinationUnavailableError(
        'storage_unavailable',
        `Storage unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return key
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}
