import { StorageService } from '@docflow/core'
import { Injectable, NotFoundException } from '@nestjs/common'

/**
 * Render a document page as PNG for the viewer (spec 5.2).
 *
 * Spec deviation: mupdf renders pages on the server instead of pdfjs-dist in
 * the browser. Source coordinates are normalized to page sizes reported by
 * mupdf during OCR, so using the same engine aligns overlays and avoids
 * CropBox/MediaBox differences. It also removes pdfjs worker configuration;
 * mupdf handles both PDFs and image scans through the same path.
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
    const mupdf = await import('mupdf')

    const document = mupdf.Document.openDocument(buffer, mimeType)
    if (pageNumber < 1 || pageNumber > document.countPages()) {
      throw new NotFoundException(`Page ${pageNumber} not found`)
    }

    const page = document.loadPage(pageNumber - 1)
    const [x0, , x1] = page.getBounds()
    const width = x1 - x0
    if (width <= 0) throw new NotFoundException('Page is empty')

    const scale = targetWidth / width
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    )
    return Buffer.from(pixmap.asPNG())
  }
}
