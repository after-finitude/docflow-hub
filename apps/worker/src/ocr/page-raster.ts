import sharp from 'sharp'

export interface RasterPage {
  pageNumber: number
  png: Buffer
  width: number
  height: number
  blank: boolean
}

/**
 * Пустая страница: практически нулевой разброс яркости при светлом среднем.
 * Такие страницы не отправляются платному провайдеру (ТЗ 6.2 — удаление
 * пустых страниц), но строка Page для них сохраняется, чтобы не сдвигать
 * нумерацию страниц относительно оригинала.
 */
async function isBlank(png: Buffer): Promise<boolean> {
  const stats = await sharp(png).stats()
  return stats.channels.every((channel) => channel.stdev < 2 && channel.mean > 245)
}

/** Растеризация всех страниц PDF под OCR. */
export async function rasterizePdf(buffer: Buffer, dpi: number): Promise<RasterPage[]> {
  const mupdf = await import('mupdf')
  const document = mupdf.Document.openDocument(buffer, 'application/pdf')
  const scale = dpi / 72

  const pages: RasterPage[] = []
  for (let index = 0; index < document.countPages(); index++) {
    const page = document.loadPage(index)
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    )
    const png = Buffer.from(pixmap.asPNG())
    pages.push({
      pageNumber: index + 1,
      png,
      width: pixmap.getWidth(),
      height: pixmap.getHeight(),
      blank: await isBlank(png),
    })
  }
  return pages
}

/**
 * Нормализация изображения перед OCR (ТЗ 6.2): поворот по EXIF и растяжение
 * контраста. Устранение перекоса не выполняется — см. known-limitations.
 */
export async function normalizeImage(buffer: Buffer): Promise<RasterPage> {
  const png = await sharp(buffer).rotate().normalize().png().toBuffer()
  const meta = await sharp(png).metadata()
  return {
    pageNumber: 1,
    png,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    blank: await isBlank(png),
  }
}
