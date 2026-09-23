import type { OcrBlock } from '@docflow/shared'
import { openPdf } from '@docflow/core'
import type { OcrPageResult } from './ocr-provider'

/** PDF text matrix [a, b, c, d, e, f] and an axis-aligned [x0, y0, x1, y1] box. */
type Matrix = [number, number, number, number, number, number]
type Box = [number, number, number, number]

/** Local text and viewport coordinates; conservative fallback for partial scan text layers. */
export async function readPdfText(buffer: Buffer) {
  const document = await openPdf(buffer)
  const pages: OcrPageResult[] = []
  const pagesNeedingOcr: number[] = []
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const imageOps = new Set(
    Object.entries(OPS)
      .filter(([name]) => /paint.*Image/.test(name))
      .map(([, code]) => code),
  )
  try {
    for (let index = 0; index < document.numPages; index++) {
      const page = await document.getPage(index + 1)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const { width, height } = viewport
        const content = await page.getTextContent({ disableNormalization: true })
        const blocks: OcrBlock[] = []
        let line = '',
          bounds: Box | null = null
        const flush = () => {
          if (line.trim() && bounds) {
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
          bounds = null
        }
        for (const item of content.items) {
          if (!('str' in item)) continue
          if (item.str) {
            const [a, b, c, d, e, f] = item.transform as Matrix
            const style = content.styles[item.fontName]
            const ascent = style?.ascent ?? 0.8,
              descent = style?.descent ?? -0.2
            const length = Math.hypot(a, b) || 1
            const dx = (a / length) * item.width,
              dy = (b / length) * item.width
            // Text transforms are in PDF coordinates; the viewport applies CropBox and rotation.
            const corners = (
              [
                [e + c * ascent, f + d * ascent],
                [e + c * ascent + dx, f + d * ascent + dy],
                [e + c * descent, f + d * descent],
                [e + c * descent + dx, f + d * descent + dy],
              ] satisfies [number, number][]
            ).map(([x, y]) => viewport.convertToViewportPoint(x, y))
            const box: Box = [
              Math.min(...corners.map((p) => p[0])),
              Math.min(...corners.map((p) => p[1])),
              Math.max(...corners.map((p) => p[0])),
              Math.max(...corners.map((p) => p[1])),
            ]
            line += item.str
            bounds = bounds
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
        const text = blocks.map((block) => block.text).join('\n')
        const operations = await page.getOperatorList()
        // ponytail: any image forces OCR, including logos; relax only after mixed-page corpus checks.
        if (
          text.trim().length < 40 ||
          [...text].some(
            (char) => char === '\uFFFD' || (char.charCodeAt(0) < 32 && !'\t\n\r'.includes(char)),
          ) ||
          operations.fnArray.some((code) => imageOps.has(code))
        )
          pagesNeedingOcr.push(index + 1)
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
  return { pages, pagesNeedingOcr }
}
