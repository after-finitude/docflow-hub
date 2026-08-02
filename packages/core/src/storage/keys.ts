/**
 * Раскладка объектного хранилища: все файлы документа лежат под общим
 * префиксом, поэтому retention-задача удаляет их одним вызовом по префиксу.
 */

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

/** `objectId` — идентификатор папки документа в хранилище, хранится в storage_key. */
export function originalKey(objectId: string, mimeType: string): string {
  return `documents/${objectId}/original.${EXTENSION_BY_MIME[mimeType] ?? 'bin'}`
}

/**
 * Миниатюра выводится из ключа оригинала, а не из id документа: id генерируется
 * базой при вставке, а файл кладётся в хранилище раньше — иначе строка
 * документа могла бы указывать на отсутствующий объект.
 */
export function thumbnailKeyFor(originalStorageKey: string): string {
  const separator = originalStorageKey.lastIndexOf('/')
  const folder = separator === -1 ? originalStorageKey : originalStorageKey.slice(0, separator)
  return `${folder}/thumbnail.png`
}

/** Префикс всех объектов документа — для удаления по retention policy (ТЗ 6.9). */
export function documentPrefix(originalStorageKey: string): string {
  const separator = originalStorageKey.lastIndexOf('/')
  return separator === -1 ? originalStorageKey : `${originalStorageKey.slice(0, separator)}/`
}
