import sharp from 'sharp'
import { StorageService } from '@docflow/core'
import { Injectable, NotFoundException } from '@nestjs/common'

/**
 * Render a document page as PNG for the viewer (spec 5.2).
 *
 * Spec deviation: mupdf renders pages on the server instead of pdfjs-dist in
 * the browser. Source coordinates are normalized to page sizes reported by
 * mupdf during OCR, so using the same engine aligns overlays and avoids
 * CropBox/MediaBox differences. It also removes pdfjs worker configuration;
 * Sharp applies the same EXIF orientation to image scans as the OCR provider.
 */
@Injectable()
export class PageRenderService {
  constructor(private readonly storage: StorageService) {}

  async render(
    storageKey: string,
    mimeType: string,
    pageNumber: number,
    targetWidth: number,
  ): Promise<Buffer> {
    const buffer = await this.storage.getBuffer(storageKey)
    if (mimeType !== 'application/pdf') {
      if (pageNumber !== 1) throw new NotFoundException(`Page ${pageNumber} not found`)
      return sharp(buffer)
        .autoOrient()
        .flatten({ background: '#fff' })
        .resize({ width: targetWidth, height: Math.floor(25_000_000 / targetWidth), fit: 'inside' })
        .png()
        .toBuffer()
    }
    const mupdf = await import('mupdf')

    const document = mupdf.Document.openDocument(buffer, mimeType)
    try {
      if (pageNumber < 1 || pageNumber > document.countPages()) {
        throw new NotFoundException(`Page ${pageNumber} not found`)
      }

      const page = document.loadPage(pageNumber - 1)
      try {
        const [x0, y0, x1, y1] = page.getBounds()
        const width = x1 - x0
        if (width <= 0) throw new NotFoundException('Page is empty')

        const scale = Math.min(targetWidth / width, Math.sqrt(25_000_000 / (width * (y1 - y0))))
        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(scale, scale),
          mupdf.ColorSpace.DeviceRGB,
          false,
          true,
        )
        try {
          return Buffer.from(pixmap.asPNG())
        } finally {
          pixmap.destroy()
        }
      } finally {
        page.destroy()
      }
    } finally {
      document.destroy()
    }
  }
}
