import type { OcrBlock } from '@docflow/shared'
import { openPdf } from '@docflow/core'
import { Injectable, Logger } from '@nestjs/common'
import sharp from 'sharp'
import type { OcrPageResult, OcrProvider, OcrResult } from './ocr-provider'

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

    const document = await openPdf(buffer)
    const pages: OcrPageResult[] = []
    try {
      for (let index = 0; index < document.numPages; index++) {
        const page = await document.getPage(index + 1)
        try {
          const viewport = page.getViewport({ scale: 1 })
          const { width, height } = viewport
          const content = await page.getTextContent({ disableNormalization: true })
          const blocks: OcrBlock[] = []
          let line = '',
            bounds: number[] = []
          const flush = () => {
            if (line.trim() && bounds.length) {
              const x = Math.max(0, bounds[0]),
                y = Math.max(0, bounds[1])
              const right = Math.min(width, bounds[2]),
                bottom = Math.min(height, bounds[3])
              if (right > x && bottom > y)
                blocks.push({
                  text: line,
                  bbox: {
                    x: x / width,
                    y: y / height,
                    width: (right - x) / width,
                    height: (bottom - y) / height,
                  },
                  confidence: 1,
                })
            }
            line = ''
            bounds = []
          }
          for (const item of content.items) {
            if (!('str' in item)) continue
            if (item.str) {
              const [a, b, c, d, e, f] = item.transform as number[]
              const style = content.styles[item.fontName]
              const ascent = style?.ascent ?? 0.8,
                descent = style?.descent ?? -0.2
              const length = Math.hypot(a, b) || 1
              const dx = (a / length) * item.width,
                dy = (b / length) * item.width
              // Text transforms are in PDF coordinates; the viewport applies CropBox and rotation.
              const corners = [
                [e + c * ascent, f + d * ascent],
                [e + c * ascent + dx, f + d * ascent + dy],
                [e + c * descent, f + d * descent],
                [e + c * descent + dx, f + d * descent + dy],
              ].map(([x, y]) => viewport.convertToViewportPoint(x, y))
              const box = [
                Math.min(...corners.map((p) => p[0])),
                Math.min(...corners.map((p) => p[1])),
                Math.max(...corners.map((p) => p[0])),
                Math.max(...corners.map((p) => p[1])),
              ]
              line += item.str
              bounds = bounds.length
                ? [
                    Math.min(bounds[0], box[0]),
                    Math.min(bounds[1], box[1]),
                    Math.max(bounds[2], box[2]),
                    Math.max(bounds[3], box[3]),
                  ]
                : box
            }
            if (item.hasEOL) flush()
          }
          flush()
          pages.push({
            pageNumber: index + 1,
            width,
            height,
            text: blocks.map((block) => block.text).join('\n'),
            confidence: blocks.length ? 1 : null,
            blocks,
            sentToProvider: false,
          })
        } finally {
          page.cleanup()
        }
      }
    } finally {
      await document.loadingTask.destroy()
    }

    return { pages }
  }
}
