import sharp from 'sharp'
import { StorageService, openPdf, renderPdfPage } from '@docflow/core'
import { Injectable, NotFoundException } from '@nestjs/common'

/**
 * Render a document page as PNG for the viewer (spec 5.2).
 *
 * PDF.js renders pages on the server using the same viewport as OCR. Sharp
 * applies the same EXIF orientation to image scans as the OCR provider.
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
    const document = await openPdf(buffer)
    try {
      if (pageNumber < 1 || pageNumber > document.numPages) {
        throw new NotFoundException(`Page ${pageNumber} not found`)
      }

      const page = await document.getPage(pageNumber)
      try {
        const { width } = page.getViewport({ scale: 1 })
        if (width <= 0) throw new NotFoundException('Page is empty')

        return (await renderPdfPage(page, targetWidth / width)).png
      } finally {
        page.cleanup()
      }
    } finally {
      await document.loadingTask.destroy()
    }
  }
}
