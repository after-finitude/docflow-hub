/**
 * Pure source-sync comparison (spec 6.1, 6.9). Providers and services retain
 * network and database work so these decisions can be tested in isolation.
 */

/** Source file; `sourcePath` is a stable path or file ID. */
export interface SourceFile {
  sourcePath: string
  name: string
  mimeType: string
  sizeBytes: number
  /**
   * Source content hash distinguishes changes from identical rewrites, whose
   * modification time would otherwise create unnecessary versions.
   */
  contentHash: string
}

/** Already ingested source file: latest active version. */
export interface KnownSourceFile {
  sourcePath: string
  checksum: string
}

export interface SourceDiff {
  /** New and changed files to download and ingest. */
  upserted: SourceFile[]
  /** Paths removed from the source whose documents become inactive. */
  deletedPaths: string[]
}

/**
 * Difference between a full source snapshot and ingested files, used by
 * cursorless sources where absence is the only deletion signal.
 */
export function diffSnapshot(snapshot: SourceFile[], known: KnownSourceFile[]): SourceDiff {
  const knownByPath = new Map(known.map((file) => [file.sourcePath, file.checksum]))
  const seen = new Set<string>()

  const upserted: SourceFile[] = []
  for (const file of snapshot) {
    seen.add(file.sourcePath)
    if (knownByPath.get(file.sourcePath) !== file.contentHash) upserted.push(file)
  }

  return {
    upserted,
    deletedPaths: known.filter((file) => !seen.has(file.sourcePath)).map((file) => file.sourcePath),
  }
}

export type IngestDecision =
  | { action: 'skip' }
  | { action: 'create'; versionNumber: 1 }
  | { action: 'version'; versionNumber: number }

/**
 * Source-file decision (spec 6.9): a new content hash at the same path creates
 * a version and deactivates the previous one; a matching hash is unchanged.
 */
export function decideIngest(
  current: { checksum: string; versionNumber: number } | null,
  incomingChecksum: string,
): IngestDecision {
  if (!current) return { action: 'create', versionNumber: 1 }
  if (current.checksum === incomingChecksum) return { action: 'skip' }
  return { action: 'version', versionNumber: current.versionNumber + 1 }
}
