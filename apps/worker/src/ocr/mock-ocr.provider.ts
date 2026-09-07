import { readPdfText } from './pdf-text'
import { Injectable, Logger } from '@nestjs/common'
import sharp from 'sharp'
import type { OcrProvider, OcrResult } from './ocr-provider'

/**
 * Deterministic OCR without external calls, using the PDF text layer through PDF.js.
 *
 * Generated demo documents have a complete text layer, so the mock returns real
 * blocks and coordinates used to test evidence→bbox. Images have no text layer,
 * so return an empty page with actual dimensions.
 */
@Injectable()
export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock'
  readonly external = false

  private readonly logger = new Logger(MockOcrProvider.name)

  async recognize(buffer: Buffer, mimeType: string): Promise<OcrResult> {
    if (mimeType !== 'application/pdf') {
      const { info: meta } = await sharp(buffer)
        .autoOrient()
        .png()
        .toBuffer({ resolveWithObject: true })
      this.logger.warn('Mock OCR does not recognize images; returning an empty page')
      return {
        pages: [
          {
            pageNumber: 1,
            width: meta.width ?? 0,
            height: meta.height ?? 0,
            text: '',
            confidence: null,
            blocks: [],
            sentToProvider: false,
          },
        ],
      }
    }

    const { pages } = await readPdfText(buffer)
    return { pages }
  }
}
