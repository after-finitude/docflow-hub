/**
 * Чистая часть синхронизации источника (ТЗ 6.1, 6.9): сопоставление того,
 * что лежит в источнике, с тем, что уже принято. Сетевые вызовы и запросы
 * к БД остаются в провайдере и сервисе, поэтому решения здесь тестируемы
 * без источника и без базы.
 */

/** Файл в источнике. `sourcePath` — устойчивый идентификатор: путь или file id. */
export interface SourceFile {
  sourcePath: string
  name: string
  mimeType: string
  sizeBytes: number
  /**
   * Хеш содержимого по данным источника. Именно он отличает изменённый файл
   * от неизменного: время модификации меняется и при перезаписи тем же
   * содержимым, и тогда синхронизация плодила бы версии на пустом месте.
   */
  contentHash: string
}

/** Уже принятый файл источника: последняя активная версия. */
export interface KnownSourceFile {
  sourcePath: string
  checksum: string
}

export interface SourceDiff {
  /** Новые и изменённые файлы — их нужно скачать и принять. */
  upserted: SourceFile[]
  /** Пути, исчезнувшие из источника: документы помечаются неактивными. */
  deletedPaths: string[]
}

/**
 * Разница между полным снимком источника и принятыми файлами.
 * Используется источниками без курсора (локальная папка): удаление
 * определяется только отсутствием файла в снимке.
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
 * Решение по файлу источника (ТЗ 6.9): новый content hash по тому же пути
 * создаёт новую версию, прежняя сохраняется и перестаёт быть актуальной.
 * Совпадение хеша — не событие: файл в источнике не менялся.
 */
export function decideIngest(
  current: { checksum: string; versionNumber: number } | null,
  incomingChecksum: string,
): IngestDecision {
  if (!current) return { action: 'create', versionNumber: 1 }
  if (current.checksum === incomingChecksum) return { action: 'skip' }
  return { action: 'version', versionNumber: current.versionNumber + 1 }
}
