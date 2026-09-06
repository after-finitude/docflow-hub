import type { OcrBlock } from '@docflow/shared'
import { Injectable, Logger } from '@nestjs/common'
import { UnrecoverableError } from 'bullmq'
import sharp from 'sharp'
import type { OcrPageResult, OcrProvider, OcrResult } from './ocr-provider'
import { normalizeImage, rasterizePdf, type RasterPage } from './page-raster'

import type { ImageAnnotatorClient, protos } from '@google-cloud/vision'

type AnnotateResponse = protos.google.cloud.vision.v1.IAnnotateImageResponse
type VisionBlock = protos.google.cloud.vision.v1.IBlock

/** Retryable gRPC codes for network, quota, and 5xx failures. */
const TRANSIENT_GRPC_CODES = new Set([2, 4, 8, 13, 14]) // UNKNOWN, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE

export interface GoogleVisionOptions {
  keyFile: string
  renderDpi: number
  languageHints: string[]
}

/**
 * Google Cloud Vision, as specified. Rasterize and send PDF pages individually
 * through the same path as images, without requiring GCS. Do not send blank
 * pages to the provider (spec 6.2).
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
        ? rasterizePdf(buffer, this.options.renderDpi)
        : [await normalizeImage(buffer)]

    const pages: OcrPageResult[] = []
    for await (const raster of rasterPages) {
      pages.push(raster.blank ? this.emptyPage(raster) : await this.recognizePage(raster))
    }
    return { pages }
  }

  private async recognizePage(raster: RasterPage): Promise<OcrPageResult> {
    let response = await this.detect(raster.png)
    const angle = this.textAngle(response)
    let width = raster.width
    let height = raster.height
    if (angle !== 0) {
      const corrected = await sharp(raster.png)
        .rotate(-angle, { background: '#fff' })
        .png()
        .toBuffer({ resolveWithObject: true })
      width = corrected.info.width
      height = corrected.info.height
      response = await this.detect(corrected.data)
    }

    const annotation = response.fullTextAnnotation
    const visionBlocks: VisionBlock[] = annotation?.pages?.[0]?.blocks ?? []

    const blocks: OcrBlock[] = visionBlocks
      .map((block) => this.toBlock(block, raster, width, height, -angle))
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
      rotationDegrees: angle === 0 ? 0 : -angle,
      providerCalls: angle === 0 ? 1 : 2,
    }
  }

  private async detect(png: Buffer): Promise<AnnotateResponse> {
    const client = await this.getClient()
    try {
      const [response] = await client.documentTextDetection({
        image: { content: png },
        imageContext: { languageHints: this.options.languageHints },
      })
      if (response.error?.message)
        throw Object.assign(new Error(response.error.message), { code: response.error.code })
      return response
    } catch (error) {
      throw this.classify(error)
    }
  }

  private textAngle(response: AnnotateResponse): number {
    const words = (response.fullTextAnnotation?.pages?.[0]?.blocks ?? [])
      .flatMap((block) => block.paragraphs ?? [])
      .flatMap((paragraph) => paragraph.words ?? [])
    let x = 0,
      y = 0,
      weight = 0,
      count = 0
    for (const word of words) {
      const vertices = word.boundingBox?.vertices ?? []
      if ((word.confidence ?? 0) < 0.7 || (word.symbols?.length ?? 0) < 2 || vertices.length !== 4)
        continue
      const dx = (vertices[1]!.x ?? 0) - (vertices[0]!.x ?? 0)
      const dy = (vertices[1]!.y ?? 0) - (vertices[0]!.y ?? 0)
      const length = Math.hypot(dx, dy)
      if (length < 5) continue
      x += dx
      y += dy
      weight += length
      count++
    }
    // ponytail: one dominant text angle, at most one correction pass; mixed orientations need manual review.
    if (count < 3 || Math.hypot(x, y) / weight < 0.9) return 0
    const angle = (Math.atan2(y, x) * 180) / Math.PI
    return Math.abs(angle) < 0.3 ? 0 : angle
  }

  private toBlock(
    block: VisionBlock,
    raster: RasterPage,
    width: number,
    height: number,
    rotation: number,
  ): OcrBlock | null {
    const vertices = block.boundingBox?.vertices ?? []
    const pageWidth = raster.width,
      pageHeight = raster.height
    if (vertices.length === 0 || pageWidth <= 0 || pageHeight <= 0) return null
    const radians = (rotation * Math.PI) / 180
    const cos = Math.cos(radians),
      sin = Math.sin(radians)
    const points = vertices.map((v) => {
      const dx = (v.x ?? 0) - width / 2,
        dy = (v.y ?? 0) - height / 2
      return {
        x: Math.max(0, Math.min(pageWidth, cos * dx + sin * dy + pageWidth / 2)),
        y: Math.max(0, Math.min(pageHeight, -sin * dx + cos * dy + pageHeight / 2)),
      }
    })
    const xs = points.map((v) => v.x),
      ys = points.map((v) => v.y)
    const x = Math.min(...xs),
      y = Math.min(...ys)

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
   * Pass transient errors through for BullMQ retries. Other failures, such as
   * a bad key or disabled API, cannot be fixed by retries, so UnrecoverableError
   * stops attempts immediately.
   */
  private classify(error: unknown): Error {
    const code = (error as { code?: number }).code
    const message = error instanceof Error ? error.message : String(error)
    if (code !== undefined && TRANSIENT_GRPC_CODES.has(code)) {
      return error instanceof Error ? error : new Error(message)
    }
    this.logger.error(`Permanent Vision API error (code ${code}): ${message}`)
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
      blank: true,
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
