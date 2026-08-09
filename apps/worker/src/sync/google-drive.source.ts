import { ACCEPTED_MIME_TYPES, UPLOAD_MAX_BYTES, type SourceFile } from '@docflow/shared'
import type { drive_v3 } from '@googleapis/drive'
import { Logger } from '@nestjs/common'
import type { SourceListing, SourceProvider } from './source-provider'

export interface GoogleDriveOptions {
  keyFile: string
  folderId: string
}

interface DriveFile {
  id?: string | null
  name?: string | null
  mimeType?: string | null
  size?: string | null
  md5Checksum?: string | null
  trashed?: boolean | null
  parents?: string[] | null
}

/**
 * Папка Google Drive с синхронизацией по курсору (ТЗ 6.1, второй этап).
 *
 * Курсор — pageToken changes API: он и есть журнал изменений источника,
 * включая удаления, которых листинг папки не показывает. Первый проход
 * снимает содержимое папки целиком и запоминает точку, с которой дальше
 * читаются только изменения.
 */
export class GoogleDriveSource implements SourceProvider {
  readonly name = 'google_drive'
  readonly sourceType = 'drive' as const

  private readonly logger = new Logger(GoogleDriveSource.name)

  constructor(private readonly options: GoogleDriveOptions) {}

  async list(cursor: string | null): Promise<SourceListing> {
    const drive = await this.client()

    if (!cursor) {
      const files: SourceFile[] = []
      let pageToken: string | undefined

      // Стартовый токен берётся ДО чтения содержимого: изменения, случившиеся
      // во время обхода, попадут в следующий проход. Обратный порядок молча
      // терял бы их.
      const start = await drive.changes.getStartPageToken({ supportsAllDrives: true })

      do {
        const page = await drive.files.list({
          q: `'${this.options.folderId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, size, md5Checksum)',
          pageSize: 100,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        })
        for (const file of page.data.files ?? []) {
          const accepted = this.toSourceFile(file)
          if (accepted) files.push(accepted)
        }
        pageToken = page.data.nextPageToken ?? undefined
      } while (pageToken)

      return { mode: 'snapshot', files, cursor: start.data.startPageToken ?? null }
    }

    const files: SourceFile[] = []
    const deletedPaths: string[] = []
    let pageToken: string | undefined = cursor
    let nextCursor: string | null = cursor

    while (pageToken) {
      // Тип ответа указан явно: без него вывод типов зацикливается на
      // pageToken, который читается из этого же ответа.
      const page: drive_v3.Schema$ChangeList = (
        await drive.changes.list({
          pageToken,
          fields:
            'nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, size, md5Checksum, trashed, parents))',
          includeRemoved: true,
          pageSize: 100,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        })
      ).data

      for (const change of page.changes ?? []) {
        const file = change.file
        // Удаление и перемещение из наблюдаемой папки для нас одно и то же:
        // файла в источнике больше нет.
        const gone =
          change.removed ||
          !file ||
          file.trashed ||
          !(file.parents ?? []).includes(this.options.folderId)

        if (gone) {
          if (change.fileId) deletedPaths.push(change.fileId)
          continue
        }

        const accepted = this.toSourceFile(file)
        if (accepted) files.push(accepted)
      }

      pageToken = page.nextPageToken ?? undefined
      if (page.newStartPageToken) nextCursor = page.newStartPageToken
    }

    return { mode: 'changes', files, deletedPaths, cursor: nextCursor }
  }

  async download(file: SourceFile): Promise<Buffer> {
    const drive = await this.client()
    const response = await drive.files.get(
      { fileId: file.sourcePath, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    )
    return Buffer.from(response.data as ArrayBuffer)
  }

  /** Файлы неподдерживаемых типов и превышающие лимит в источник не попадают. */
  private toSourceFile(file: DriveFile): SourceFile | null {
    const mimeType = file.mimeType ?? ''
    if (!file.id || !(ACCEPTED_MIME_TYPES as readonly string[]).includes(mimeType)) return null

    const sizeBytes = Number(file.size ?? 0)
    if (sizeBytes > UPLOAD_MAX_BYTES) {
      this.logger.warn(`Файл ${file.name} больше лимита ${UPLOAD_MAX_BYTES} Б и пропущен`)
      return null
    }

    return {
      // Идентификатор файла, а не имя: переименование не должно выглядеть
      // как удаление старого документа и приём нового.
      sourcePath: file.id,
      name: file.name ?? file.id,
      mimeType,
      sizeBytes,
      contentHash: file.md5Checksum ?? '',
    }
  }

  private async client(): Promise<drive_v3.Drive> {
    const { drive, auth } = await import('@googleapis/drive')
    const authClient = new auth.GoogleAuth({
      keyFile: this.options.keyFile,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    })
    return drive({ version: 'v3', auth: authClient })
  }
}
