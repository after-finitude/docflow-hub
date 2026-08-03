import type { OcrBlock } from '@docflow/shared'

/**
 * Контракт OCR-этапа (ТЗ 6.2). Интерфейс спроектирован под формат Google
 * Cloud Vision (блоки с полигонами → прямоугольники, confidence по блокам);
 * mock-реализация обязана выдавать ту же форму.
 */

export interface OcrPageResult {
  pageNumber: number
  /** Размеры страницы в единицах, к которым нормализованы bbox (пиксели растра или пункты PDF). */
  width: number
  height: number
  text: string
  /** Средняя уверенность по блокам; null, если блоков нет. */
  confidence: number | null
  blocks: OcrBlock[]
  /** Страница уходила внешнему провайдеру — для журнала отправок (ТЗ §11). */
  sentToProvider: boolean
}

export interface OcrResult {
  pages: OcrPageResult[]
}

export interface OcrProvider {
  readonly name: string
  /** true — провайдер отправляет данные за пределы системы. */
  readonly external: boolean
  recognize(buffer: Buffer, mimeType: string): Promise<OcrResult>
}

export const OCR_PROVIDER = Symbol('OCR_PROVIDER')
