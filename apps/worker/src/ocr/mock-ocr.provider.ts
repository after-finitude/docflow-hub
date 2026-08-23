import type { OcrBlock } from '@docflow/shared'
import { Injectable, Logger } from '@nestjs/common'
import sharp from 'sharp'
import type { OcrPageResult, OcrProvider, OcrResult } from './ocr-provider'

interface StructuredLine {
  text: string
  bbox: { x: number; y: number; w: number; h: number }
}

interface StructuredBlock {
  type: string
  bbox: { x: number; y: number; w: number; h: number }
  lines: StructuredLine[]
}

/**
 * Deterministic OCR without external calls, using the PDF text layer through mupdf.
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
      const meta = await sharp(buffer).rotate().metadata()
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

    const mupdf = await import('mupdf')
    const document = mupdf.Document.openDocument(buffer, 'application/pdf')

    const pages: OcrPageResult[] = []
    for (let index = 0; index < document.countPages(); index++) {
      const page = document.loadPage(index)
      const [x0, y0, x1, y1] = page.getBounds()
      const width = x1 - x0
      const height = y1 - y0

      const structured = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
        blocks: StructuredBlock[]
      }

      // A mupdf block may span lines; evidence → bbox needs line granularity,
      // so treat each line as a block.
      const blocks: OcrBlock[] = structured.blocks
        .filter((block) => block.type === 'text')
        .flatMap((block) => block.lines)
        .filter((line) => line.text.trim().length > 0)
        .map((line) => ({
          text: line.text,
          bbox: {
            x: (line.bbox.x - x0) / width,
            y: (line.bbox.y - y0) / height,
            width: line.bbox.w / width,
            height: line.bbox.h / height,
          },
          // A PDF text layer is not recognition; its text is exact.
          confidence: 1,
        }))

      pages.push({
        pageNumber: index + 1,
        width,
        height,
        text: blocks.map((block) => block.text).join('\n'),
        confidence: blocks.length > 0 ? 1 : null,
        blocks,
        sentToProvider: false,
      })
    }

    return { pages }
  }
}
