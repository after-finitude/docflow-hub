import { StorageService } from '@docflow/core'
import type { CanonicalDocument, ExportDestination } from '@docflow/shared'
import { Injectable } from '@nestjs/common'
import { DestinationUnavailableError, type ExportAdapter } from './export-adapter'

/**
 * Выгрузка канонического JSON в объектное хранилище (ТЗ 6.8).
 * Маппинг не применяется: канонический вид и есть содержимое файла.
 */
@Injectable()
export class FileJsonAdapter implements ExportAdapter {
  readonly destination: ExportDestination = 'file_json'

  constructor(private readonly storage: StorageService) {}

  async send(canonical: CanonicalDocument, _mapping: unknown, exportKey: string): Promise<string> {
    // Ключ идемпотентности в имени объекта: повторная отправка того же экспорта
    // перезаписывает тот же файл, а не плодит копии.
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
        `Хранилище недоступно: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return key
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}
