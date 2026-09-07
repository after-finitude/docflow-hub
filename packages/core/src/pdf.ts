import { createCanvas } from '@napi-rs/canvas'
import { dirname, join } from 'node:path'
import type { PDFPageProxy, RenderParameters } from 'pdfjs-dist/types/src/display/api'

const assets = dirname(require.resolve('pdfjs-dist/package.json'))

/** Local bytes only; fonts/CMaps/WASM come from the installed package. */
export async function openPdf(buffer: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({
    data: Uint8Array.from(buffer),
    stopAtErrors: true,
    verbosity: 0,
    useSystemFonts: false,
    useWorkerFetch: false,
    standardFontDataUrl: join(assets, 'standard_fonts/'),
    cMapUrl: join(assets, 'cmaps/'),
    wasmUrl: join(assets, 'wasm/'),
  })
  try {
    return await loading.promise
  } catch (error) {
    await loading.destroy()
    throw error
  }
}

/** One bounded raster, shared by inspection, OCR and the Review Workspace. */
export async function renderPdfPage(page: PDFPageProxy, requestedScale: number) {
  const size = page.getViewport({ scale: 1 })
  if (!(size.width > 0 && size.height > 0 && Number.isFinite(size.width * size.height)))
    throw new Error('Invalid PDF page dimensions')
  const scale = Math.min(requestedScale, Math.sqrt(25_000_000 / (size.width * size.height)))
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(
    Math.max(1, Math.floor(viewport.width)),
    Math.max(1, Math.floor(viewport.height)),
  )
  try {
    await page.render({ canvas: canvas as unknown as RenderParameters['canvas'], viewport }).promise
    return { png: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height }
  } finally {
    canvas.width = 1
    canvas.height = 1
  }
}
