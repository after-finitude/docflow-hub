import type { SourceFile, SourceType } from '@docflow/shared'

export const SOURCE_PROVIDER = Symbol('SOURCE_PROVIDER')

/**
 * Результат одного прохода по источнику.
 *
 * Два режима, потому что источники отличаются принципиально: у Google Drive
 * есть changes API с курсором и явными событиями удаления, у наблюдаемой
 * папки — только текущее содержимое. Сводить их к одному виду пришлось бы
 * ценой выдумывания событий, которых источник не сообщал.
 */
export type SourceListing =
  | { mode: 'snapshot'; files: SourceFile[]; cursor: string | null }
  | { mode: 'changes'; files: SourceFile[]; deletedPaths: string[]; cursor: string | null }

export interface SourceProvider {
  readonly name: string
  readonly sourceType: SourceType
  /** Курсор — то, что вернул предыдущий проход; null при первом запуске. */
  list(cursor: string | null): Promise<SourceListing>
  download(file: SourceFile): Promise<Buffer>
}
