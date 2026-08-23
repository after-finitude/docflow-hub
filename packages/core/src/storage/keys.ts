/**
 * Object-storage layout. All document files share a prefix so retention can
 * delete them in one prefix operation.
 */

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

/** `objectId` identifies the document's storage folder and is stored in storage_key. */
export function originalKey(objectId: string, mimeType: string): string {
  return `documents/${objectId}/original.${EXTENSION_BY_MIME[mimeType] ?? 'bin'}`
}

/**
 * Derive the thumbnail from the original key rather than document ID because
 * storage happens before the database generates the ID.
 */
export function thumbnailKeyFor(originalStorageKey: string): string {
  const separator = originalStorageKey.lastIndexOf('/')
  const folder = separator === -1 ? originalStorageKey : originalStorageKey.slice(0, separator)
  return `${folder}/thumbnail.png`
}

/** Prefix for every document object, used by retention deletion (spec 6.9). */
export function documentPrefix(originalStorageKey: string): string {
  const separator = originalStorageKey.lastIndexOf('/')
  return separator === -1 ? originalStorageKey : `${originalStorageKey.slice(0, separator)}/`
}
