import type { CanonicalDocument, ExportDestination, ExportMapping } from '@docflow/shared'

/**
 * Destination adapter (spec 6.8). Receives canonical JSON and a mapping without
 * knowing how the document was processed.
 */
export interface ExportAdapter {
  readonly destination: ExportDestination
  /**
   * @returns payloadRef referencing the created destination object.
   * @throws DestinationUnavailableError when the destination is unavailable.
   */
  send(canonical: CanonicalDocument, mapping: ExportMapping, exportKey: string): Promise<string>
}

/**
 * Destination unavailable. The document remains Approved, the export becomes
 * Failed, and operators can retry manually; there are no automatic retries
 * (spec 6.8, 6.10).
 */
export class DestinationUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DestinationUnavailableError'
  }
}

export const EXPORT_ADAPTERS = Symbol('EXPORT_ADAPTERS')
