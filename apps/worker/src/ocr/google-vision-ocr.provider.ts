import type { OcrBlock } from '@docflow/shared'
import { Injectable, Logger } from '@nestjs/common'
import { UnrecoverableError } from 'bullmq'
import type { OcrPageResult, OcrProvider, OcrResult } from './ocr-provider'
import { normalizeImage, rasterizePdf, type RasterPage } from './page-raster'

import type { ImageAnnotatorClient, protos } from '@google-cloud/vision'

type AnnotateResponse = protos.google.cloud.vision.v1.IAnnotateImageResponse
type VisionBlock = protos.google.cloud.vision.v1.IBlock

/** Коды gRPC, при которых повтор осмыслен (сеть, лимиты, 5xx). */
const TRANSIENT_GRPC_CODES = new Set([2, 4, 8, 13, 14]) // UNKNOWN, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE

export interface GoogleVisionOptions {
  keyFile: string
  renderDpi: number
  languageHints: string[]
}

/**
 * Google Cloud Vision (ТЗ, стек). Страницы PDF растеризуются и отправляются
 * по одной: единый путь для PDF и изображений, без обязательного GCS.
 * Пустые страницы провайдеру не отправляются (ТЗ 6.2).
 */
@Injectable()
export class GoogleVisionOcrProvider implements OcrProvider {
  readonly name = 'google-vision'
  readonly external = true

  private readonly logger = new Logger(GoogleVisionOcrProvider.name)
  private client?: ImageAnnotatorClient

  constructor(private readonly options: GoogleVisionOptions) {}

  async recognize(buffer: Buffer, mimeType: string): Promise<OcrResult> {
    const rasterPages =
      mimeType === 'application/pdf'
        ? await rasterizePdf(buffer, this.options.renderDpi)
        : [await normalizeImage(buffer)]

    const pages: OcrPageResult[] = []
    for (const raster of rasterPages) {
      pages.push(raster.blank ? this.emptyPage(raster) : await this.recognizePage(raster))
    }
    return { pages }
  }

  private async recognizePage(raster: RasterPage): Promise<OcrPageResult> {
    const client = await this.getClient()

    let response: AnnotateResponse
    try {
      const [result] = await client.documentTextDetection({
        image: { content: raster.png },
        imageContext: { languageHints: this.options.languageHints },
      })
      response = result
    } catch (error) {
      throw this.classify(error)
    }

    // API может вернуть ошибку в теле ответа вместо исключения.
    if (response.error?.message) {
      throw this.classify(
        Object.assign(new Error(response.error.message), { code: response.error.code }),
      )
    }

    const annotation = response.fullTextAnnotation
    const visionBlocks: VisionBlock[] = annotation?.pages?.[0]?.blocks ?? []

    const blocks: OcrBlock[] = visionBlocks
      .map((block) => this.toBlock(block, raster.width, raster.height))
      .filter((block): block is OcrBlock => block !== null)

    return {
      pageNumber: raster.pageNumber,
      width: raster.width,
      height: raster.height,
      text: annotation?.text ?? '',
      confidence: blocks.length
        ? blocks.reduce((sum, block) => sum + block.confidence, 0) / blocks.length
        : null,
      blocks,
      sentToProvider: true,
    }
  }

  private toBlock(block: VisionBlock, pageWidth: number, pageHeight: number): OcrBlock | null {
    const vertices = block.boundingBox?.vertices ?? []
    if (vertices.length === 0 || pageWidth <= 0 || pageHeight <= 0) return null

    const xs = vertices.map((v) => v.x ?? 0)
    const ys = vertices.map((v) => v.y ?? 0)
    const x = Math.min(...xs)
    const y = Math.min(...ys)

    const text = (block.paragraphs ?? [])
      .flatMap((paragraph) => paragraph.words ?? [])
      .map((word) => (word.symbols ?? []).map((symbol) => symbol.text ?? '').join(''))
      .join(' ')
      .trim()
    if (!text) return null

    return {
      text,
      bbox: {
        x: x / pageWidth,
        y: y / pageHeight,
        width: (Math.max(...xs) - x) / pageWidth,
        height: (Math.max(...ys) - y) / pageHeight,
      },
      confidence: block.confidence ?? 0,
    }
  }

  /**
   * Транзиентные ошибки пробрасываются как есть — политика повторов BullMQ
   * их отработает. Остальные (неверный ключ, выключенный API) повторами не
   * лечатся: UnrecoverableError останавливает попытки сразу.
   */
  private classify(error: unknown): Error {
    const code = (error as { code?: number }).code
    const message = error instanceof Error ? error.message : String(error)
    if (code !== undefined && TRANSIENT_GRPC_CODES.has(code)) {
      return error instanceof Error ? error : new Error(message)
    }
    this.logger.error(`Постоянная ошибка Vision API (код ${code}): ${message}`)
    return new UnrecoverableError(`Vision API: ${message}`)
  }

  private emptyPage(raster: RasterPage): OcrPageResult {
    return {
      pageNumber: raster.pageNumber,
      width: raster.width,
      height: raster.height,
      text: '',
      confidence: null,
      blocks: [],
      sentToProvider: false,
    }
  }

  private async getClient(): Promise<ImageAnnotatorClient> {
    if (!this.client) {
      const vision = await import('@google-cloud/vision')
      this.client = new vision.ImageAnnotatorClient({ keyFilename: this.options.keyFile })
    }
    return this.client
  }
}
