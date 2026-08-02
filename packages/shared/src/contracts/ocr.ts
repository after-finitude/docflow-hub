/**
 * Геометрия источника значения. Координаты нормализованы к размеру страницы
 * (0..1), чтобы фронтенд масштабировал оверлеи независимо от DPI рендера
 * (ТЗ 5.2 — подсветка области-источника).
 */
export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

/** Блок текста от OCR-провайдера, ТЗ 6.2. */
export interface OcrBlock {
  text: string
  bbox: BoundingBox
  confidence: number
}
