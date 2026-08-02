import sharp from 'sharp'

/**
 * Проверка файла и миниатюра первой страницы (ТЗ 6.1).
 *
 * Всё, что здесь отбраковывается, — постоянные дефекты файла: повтор их не
 * исправит, и до LLM такой документ не доходит (ТЗ §9, §10).
 */

export const THUMBNAIL_WIDTH = 240

export type InspectionResult =
  { ok: true; pageCount: number; thumbnail: Buffer } | { ok: false; code: string; reason: string }

/** Сигнатуры содержимого: заявленный клиентом mime-type проверяется, а не принимается на веру. */
const MAGIC: Record<string, { bytes: number[]; label: string }> = {
  'application/pdf': { bytes: [0x25, 0x50, 0x44, 0x46], label: 'PDF' },
  'image/jpeg': { bytes: [0xff, 0xd8, 0xff], label: 'JPEG' },
  'image/png': { bytes: [0x89, 0x50, 0x4e, 0x47], label: 'PNG' },
}

function matchesMagic(buffer: Buffer, mimeType: string): boolean {
  const magic = MAGIC[mimeType]
  if (!magic) return false
  return magic.bytes.every((byte, index) => buffer[index] === byte)
}

export async function inspect(buffer: Buffer, mimeType: string): Promise<InspectionResult> {
  if (buffer.length === 0) {
    return { ok: false, code: 'empty_file', reason: 'Файл пуст' }
  }
  if (!matchesMagic(buffer, mimeType)) {
    const expected = MAGIC[mimeType]?.label ?? mimeType
    return {
      ok: false,
      code: 'content_mismatch',
      reason: `Содержимое файла не является ${expected}: расширение или тип не соответствуют данным`,
    }
  }

  return mimeType === 'application/pdf' ? inspectPdf(buffer) : inspectImage(buffer)
}

async function inspectPdf(buffer: Buffer): Promise<InspectionResult> {
  // mupdf — ESM-пакет с top-level await, поэтому только динамический импорт:
  // require падает с ERR_REQUIRE_ASYNC_MODULE.
  const mupdf = await import('mupdf')

  let document: ReturnType<typeof mupdf.Document.openDocument>
  try {
    document = mupdf.Document.openDocument(buffer, 'application/pdf')
  } catch (error) {
    return {
      ok: false,
      code: 'corrupted_pdf',
      reason: `PDF повреждён и не может быть прочитан: ${describe(error)}`,
    }
  }

  if (document.needsPassword()) {
    return {
      ok: false,
      code: 'password_protected',
      reason: 'PDF защищён паролем. Загрузите файл без защиты',
    }
  }

  const pageCount = document.countPages()
  if (pageCount < 1) {
    return { ok: false, code: 'no_pages', reason: 'В документе нет страниц' }
  }

  try {
    const page = document.loadPage(0)
    const [x0, y0, x1, y1] = page.getBounds()
    const width = x1 - x0
    const height = y1 - y0
    if (width <= 0 || height <= 0) {
      return { ok: false, code: 'empty_page', reason: 'Первая страница пуста' }
    }

    const scale = THUMBNAIL_WIDTH / width
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    )
    return { ok: true, pageCount, thumbnail: Buffer.from(pixmap.asPNG()) }
  } catch (error) {
    return {
      ok: false,
      code: 'render_failed',
      reason: `Не удалось отрисовать первую страницу: ${describe(error)}`,
    }
  }
}

async function inspectImage(buffer: Buffer): Promise<InspectionResult> {
  try {
    const thumbnail = await sharp(buffer)
      // rotate() без аргументов применяет ориентацию из EXIF — иначе миниатюра
      // окажется повёрнутой относительно того, что видит оператор.
      .rotate()
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .png()
      .toBuffer()
    return { ok: true, pageCount: 1, thumbnail }
  } catch (error) {
    return {
      ok: false,
      code: 'corrupted_image',
      reason: `Изображение повреждено и не может быть прочитано: ${describe(error)}`,
    }
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}
