import sharp from 'sharp'
import { openPdf, renderPdfPage } from '@docflow/core'

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
export async function* rasterizePdf(
  buffer: Buffer,
  dpi: number,
  pageNumbers?: number[],
): AsyncGenerator<RasterPage> {
  const document = await openPdf(buffer)
  try {
    for (let index = 0; index < document.numPages; index++) {
      if (pageNumbers && !pageNumbers.includes(index + 1)) continue
      const page = await document.getPage(index + 1)
      let raster: RasterPage
      try {
        const { png } = await renderPdfPage(page, dpi / 72)
        raster = await prepare(png, index + 1)
      } finally {
        page.cleanup()
      }
      yield raster
    }
  } finally {
    await document.loadingTask.destroy()
  }
}

/** EXIF orientation is part of the original's displayed coordinate system. */
export async function normalizeImage(buffer: Buffer): Promise<RasterPage> {
  const png = await sharp(buffer).autoOrient().flatten({ background: '#fff' }).png().toBuffer()
  return prepare(png, 1)
}
