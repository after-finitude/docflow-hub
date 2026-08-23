import sharp from 'sharp'

export interface RasterPage {
  pageNumber: number
  png: Buffer
  width: number
  height: number
  blank: boolean
}

/**
 * A blank page has near-zero brightness variance and a light mean. Do not send
 * it to the paid provider (spec 6.2), but retain its Page row so numbering still
 * matches the original.
 */
async function isBlank(png: Buffer): Promise<boolean> {
  const stats = await sharp(png).stats()
  return stats.channels.every((channel) => channel.stdev < 2 && channel.mean > 245)
}

/** Rasterize every PDF page for OCR. */
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
 * Normalize images before OCR (spec 6.2): apply EXIF rotation and stretch
 * contrast. Deskewing is not implemented; see known-limitations.
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
