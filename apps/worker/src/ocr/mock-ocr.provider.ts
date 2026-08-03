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
 * Детерминированный OCR без внешних вызовов: текстовый слой PDF через mupdf.
 *
 * Для сгенерированных демо-документов (HTML → PDF, этап 8) текстовый слой
 * полон, поэтому mock даёт настоящие блоки с настоящими координатами — на них
 * же тестируется evidence→bbox (этап 4). Для изображений текстового слоя нет:
 * возвращается пустая страница с реальными размерами.
 */
@Injectable()
export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock'
  readonly external = false

  private readonly logger = new Logger(MockOcrProvider.name)

  async recognize(buffer: Buffer, mimeType: string): Promise<OcrResult> {
    if (mimeType !== 'application/pdf') {
      const meta = await sharp(buffer).rotate().metadata()
      this.logger.warn('Mock-OCR не распознаёт изображения: возвращена пустая страница')
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

      // Блок mupdf может накрывать несколько строк; для сопоставления
      // evidence → bbox нужна построчная гранулярность, поэтому блоками
      // становятся строки.
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
          // Текстовый слой PDF — не распознавание: текст известен точно.
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
