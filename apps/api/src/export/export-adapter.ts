import type { CanonicalDocument, ExportDestination, ExportMapping } from '@docflow/shared'

/**
 * Адаптер системы назначения (ТЗ 6.8). Получает канонический JSON и маппинг;
 * ничего не знает о том, как документ обрабатывался.
 */
export interface ExportAdapter {
  readonly destination: ExportDestination
  /**
   * @returns payloadRef — ссылка на созданный объект в системе назначения.
   * @throws DestinationUnavailableError при недоступности назначения.
   */
  send(canonical: CanonicalDocument, mapping: ExportMapping, exportKey: string): Promise<string>
}

/**
 * Назначение недоступно. Документ остаётся Approved, экспорт получает статус
 * Failed и доступен ручной повтор; автоповторов нет (ТЗ 6.8, 6.10).
 */
export class DestinationUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DestinationUnavailableError'
  }
}

export const EXPORT_ADAPTERS = Symbol('EXPORT_ADAPTERS')
