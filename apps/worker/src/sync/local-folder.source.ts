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
 * Наблюдаемая папка — источник без внешних зависимостей: он проверяется
 * на живом стенде, тогда как Google Drive требует ключа service account.
 * Роль та же, что у mock-провайдеров OCR и LLM: сквозной путь должен быть
 * воспроизводим без учётных данных.
 *
 * Курсора у папки нет: файловая система не хранит журнал изменений, поэтому
 * каждый проход отдаёт полный снимок, а новые, изменённые и удалённые файлы
 * вычисляются сравнением с уже принятыми (diffSnapshot).
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
      // Отсутствие папки — конфигурационная ошибка, а не пустой источник:
      // молчаливый пустой снимок пометил бы все документы удалёнными.
      throw new Error(`Папка источника ${this.directory} недоступна`, { cause: error })
    }

    const files: SourceFile[] = []
    for (const entry of entries) {
      const mimeType = MIME_BY_EXTENSION[extname(entry).toLowerCase()]
      if (!mimeType || !(ACCEPTED_MIME_TYPES as readonly string[]).includes(mimeType)) continue

      const absolute = join(this.directory, entry)
      const info = await stat(absolute)
      if (!info.isFile()) continue
      if (info.size > UPLOAD_MAX_BYTES) {
        this.logger.warn(`Файл ${entry} больше лимита ${UPLOAD_MAX_BYTES} Б и пропущен`)
        continue
      }

      // Хеш считается здесь, а не при приёме: без него изменение файла
      // неотличимо от простого перезаписывания тем же содержимым.
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
    // Путь приходит из листинга этой же папки, но проверка дешевле разбора
    // последствий: `..` в имени вывел бы чтение за пределы источника.
    if (relative(this.directory, absolute).startsWith('..')) {
      throw new Error(`Путь ${file.sourcePath} выходит за пределы папки источника`)
    }
    return readFile(absolute)
  }
}
