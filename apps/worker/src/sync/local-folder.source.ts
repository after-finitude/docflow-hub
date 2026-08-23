import { ACCEPTED_MIME_TYPES, UPLOAD_MAX_BYTES, type SourceFile } from '@docflow/shared'
import { Logger } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import type { SourceListing, SourceProvider } from './source-provider'

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
}

/**
 * A watched folder is a source without external dependencies, usable on a live
 * environment while Google Drive requires service-account credentials. Like the
 * mock OCR and LLM providers, it keeps the end-to-end path reproducible.
 *
 * The filesystem has no change cursor, so every pass returns a full snapshot;
 * diffSnapshot compares it with accepted files to find additions, changes, and removals.
 */
export class LocalFolderSource implements SourceProvider {
  readonly name = 'local_folder'
  readonly sourceType = 'drive' as const

  private readonly logger = new Logger(LocalFolderSource.name)

  constructor(private readonly directory: string) {}

  async list(): Promise<SourceListing> {
    let entries: string[]
    try {
      entries = await readdir(this.directory, { recursive: true })
    } catch (error) {
      // A missing directory is a configuration error, not an empty source;
      // treating it as empty would mark every document removed.
      throw new Error(`Source directory ${this.directory} is unavailable`, { cause: error })
    }

    const files: SourceFile[] = []
    for (const entry of entries) {
      const mimeType = MIME_BY_EXTENSION[extname(entry).toLowerCase()]
      if (!mimeType || !(ACCEPTED_MIME_TYPES as readonly string[]).includes(mimeType)) continue

      const absolute = join(this.directory, entry)
      const info = await stat(absolute)
      if (!info.isFile()) continue
      if (info.size > UPLOAD_MAX_BYTES) {
        this.logger.warn(`File ${entry} exceeds the ${UPLOAD_MAX_BYTES} B limit and was skipped`)
        continue
      }

      // Hash here rather than during ingest so changed content differs from a
      // rewrite with identical content.
      const buffer = await readFile(absolute)
      files.push({
        sourcePath: entry.split(sep).join('/'),
        name: entry.split(sep).pop() ?? entry,
        mimeType,
        sizeBytes: info.size,
        contentHash: createHash('sha256').update(buffer).digest('hex'),
      })
    }

    return { mode: 'snapshot', files, cursor: null }
  }

  async download(file: SourceFile): Promise<Buffer> {
    const absolute = join(this.directory, file.sourcePath)
    // The path came from this directory's listing, but validate it anyway so a
    // `..` name cannot escape the source.
    if (relative(this.directory, absolute).startsWith('..')) {
      throw new Error(`Path ${file.sourcePath} escapes the source directory`)
    }
    return readFile(absolute)
  }
}
