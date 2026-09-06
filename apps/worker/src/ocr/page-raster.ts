import sharp from 'sharp'

export interface RasterPage {
  pageNumber: number
  png: Buffer
  width: number
  height: number
  blank: boolean
}

async function prepare(png: Buffer, pageNumber: number): Promise<RasterPage> {
  const stats = await sharp(png).stats()
  // Do not discard sparse or faint text merely because its average variance is low.
  const blank = stats.channels.every(
    (channel) => channel.min > 180 && channel.max - channel.min < 3,
  )
  const lowContrast = stats.channels.every((channel) => channel.max - channel.min < 100)
  const pipeline = sharp(png)
  if (!blank && lowContrast) pipeline.normalise({ lower: 0, upper: 100 })
  const { data, info } = await pipeline.png().toBuffer({ resolveWithObject: true })
  return { pageNumber, png: data, width: info.width, height: info.height, blank }
}

/** Rasterize one PDF page at a time; release native pixmaps before provider waits. */
export async function* rasterizePdf(buffer: Buffer, dpi: number): AsyncGenerator<RasterPage> {
  const mupdf = await import('mupdf')
  const document = mupdf.Document.openDocument(buffer, 'application/pdf')
  try {
    for (let index = 0; index < document.countPages(); index++) {
      const page = document.loadPage(index)
      let raster: RasterPage
      try {
        const [x0, y0, x1, y1] = page.getBounds()
        const scale = Math.min(dpi / 72, Math.sqrt(25_000_000 / ((x1 - x0) * (y1 - y0))))
        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(scale, scale),
          mupdf.ColorSpace.DeviceRGB,
          false,
          true,
        )
        let png: Buffer
        try {
          png = Buffer.from(pixmap.asPNG())
        } finally {
          pixmap.destroy()
        }
        raster = await prepare(png, index + 1)
      } finally {
        page.destroy()
      }
      yield raster
    }
  } finally {
    document.destroy()
  }
}

/** EXIF orientation is part of the original's displayed coordinate system. */
export async function normalizeImage(buffer: Buffer): Promise<RasterPage> {
  const png = await sharp(buffer).autoOrient().flatten({ background: '#fff' }).png().toBuffer()
  return prepare(png, 1)
}
