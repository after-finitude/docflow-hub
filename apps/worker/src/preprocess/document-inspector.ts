import sharp from 'sharp'

/**
 * File inspection and first-page thumbnail (spec 6.1).
 *
 * Every rejection here is a permanent file defect that retries cannot fix;
 * rejected documents never reach the LLM (spec §9, §10).
 */

export const THUMBNAIL_WIDTH = 240

export type InspectionResult =
  { ok: true; pageCount: number; thumbnail: Buffer } | { ok: false; code: string; reason: string }

/** Content signatures verify the client-supplied MIME type instead of trusting it. */
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
    return { ok: false, code: 'empty_file', reason: 'File is empty' }
  }
  if (!matchesMagic(buffer, mimeType)) {
    const expected = MAGIC[mimeType]?.label ?? mimeType
    return {
      ok: false,
      code: 'content_mismatch',
      reason: `File content is not ${expected}; the extension or type does not match the data`,
    }
  }

  return mimeType === 'application/pdf' ? inspectPdf(buffer) : inspectImage(buffer)
}

async function inspectPdf(buffer: Buffer): Promise<InspectionResult> {
  // mupdf is an ESM package with top-level await, so require fails with
  // ERR_REQUIRE_ASYNC_MODULE; use a dynamic import.
  const mupdf = await import('mupdf')

  let document: ReturnType<typeof mupdf.Document.openDocument> | undefined
  let renderError: string | undefined
  // MuPDF can recover from broken streams without throwing. Inspection is synchronous
  // while this callback is installed, so other jobs cannot interleave with it.
  mupdf.setLog({
    error: (message) => {
      renderError ??= message
    },
    warning: (message) => console.warn(message),
  })
  try {
    document = mupdf.Document.openDocument(buffer, 'application/pdf')
    if (document.needsPassword())
      return {
        ok: false,
        code: 'password_protected',
        reason: 'PDF is password-protected. Upload an unprotected file',
      }
    const pageCount = document.countPages()
    if (pageCount < 1) return { ok: false, code: 'no_pages', reason: 'Document has no pages' }
    let thumbnail: Buffer | undefined
    for (let index = 0; index < pageCount; index++) {
      const page = document.loadPage(index)
      try {
        const [x0, y0, x1, y1] = page.getBounds()
        const width = x1 - x0,
          height = y1 - y0
        if (!(width > 0 && height > 0 && Number.isFinite(width * height)))
          return {
            ok: false,
            code: 'empty_page',
            reason: `Page ${index + 1} has invalid dimensions`,
          }
        const scale = THUMBNAIL_WIDTH / Math.max(width, height)
        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(scale, scale),
          mupdf.ColorSpace.DeviceRGB,
          false,
          true,
        )
        try {
          if (index === 0) thumbnail = Buffer.from(pixmap.asPNG())
        } finally {
          pixmap.destroy()
        }
      } finally {
        page.destroy()
      }
      if (renderError) throw new Error(`Page ${index + 1}: ${renderError}`)
    }
    if (document instanceof mupdf.PDFDocument && document.wasRepaired())
      throw new Error('PDF structure requires repair')
    return { ok: true, pageCount, thumbnail: thumbnail! }
  } catch (error) {
    return {
      ok: false,
      code: 'corrupted_pdf',
      reason: `PDF is corrupted and cannot be read: ${describe(error)}`,
    }
  } finally {
    document?.destroy()
    mupdf.setLog(null)
  }
}

async function inspectImage(buffer: Buffer): Promise<InspectionResult> {
  try {
    const thumbnail = await sharp(buffer)
      // rotate() without arguments applies EXIF orientation so the thumbnail
      // matches what the operator sees.
      .rotate()
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .png()
      .toBuffer()
    return { ok: true, pageCount: 1, thumbnail }
  } catch (error) {
    return {
      ok: false,
      code: 'corrupted_image',
      reason: `Image is corrupted and cannot be read: ${describe(error)}`,
    }
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}
