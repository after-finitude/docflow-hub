import type { SourceFile, SourceType } from '@docflow/shared'

export const SOURCE_PROVIDER = Symbol('SOURCE_PROVIDER')

/**
 * Result of one source pass.
 *
 * Two modes reflect fundamentally different sources: Google Drive has a
 * cursor-based changes API with deletion events, while a watched folder exposes
 * only current content. A single shape would require inventing events.
 */
export type SourceListing =
  | { mode: 'snapshot'; files: SourceFile[]; cursor: string | null }
  | { mode: 'changes'; files: SourceFile[]; deletedPaths: string[]; cursor: string | null }

export interface SourceProvider {
  readonly name: string
  readonly sourceType: SourceType
  /** Cursor returned by the previous pass, or null on the first run. */
  list(cursor: string | null): Promise<SourceListing>
  download(file: SourceFile): Promise<Buffer>
}
