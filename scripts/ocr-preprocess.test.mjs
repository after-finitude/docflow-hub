import 'reflect-metadata'
import { readFile } from 'node:fs/promises'
import { uploadFile } from '../apps/web/lib/upload-file.ts'
import { UPLOAD_MAX_BYTES } from '@docflow/shared'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { PDFDocument, PDFName, rgb } from 'pdf-lib'
import { normalizeImage, rasterizePdf } from '../apps/worker/dist/ocr/page-raster.js'
import { GoogleVisionOcrProvider } from '../apps/worker/dist/ocr/google-vision-ocr.provider.js'
import { MockOcrProvider } from '../apps/worker/dist/ocr/mock-ocr.provider.js'
import { inspect } from '../apps/worker/dist/preprocess/document-inspector.js'
import { PageRenderService } from '../apps/api/dist/documents/page-render.service.js'

const labels = ['Invoice', 'Счёт', 'Total']
const corners = (x, y, w, h) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
]
const response = (vertices, confidence = 0.99) => ({
  fullTextAnnotation: {
    text: labels.join(' '),
    pages: [
      {
        blocks: [
          {
            confidence,
            boundingBox: { vertices },
            paragraphs: [
              {
                words: labels.map((text) => ({
                  confidence,
                  boundingBox: { vertices },
                  symbols: [...text].map((symbol) => ({ text: symbol })),
                })),
              },
            ],
          },
        ],
      },
    ],
  },
})
const upright = await sharp(
  Buffer.from(
    '<svg width="300" height="400"><rect width="300" height="400" fill="white"/><rect x="50" y="60" width="180" height="70" fill="none" stroke="black" stroke-width="2"/><text x="60" y="90" font-size="18">Invoice Счёт</text><text x="60" y="115" font-size="16">Total 100</text></svg>',
  ),
)
  .png()
  .toBuffer()

async function inkBounds(png) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let x0 = info.width,
    y0 = info.height,
    x1 = -1,
    y1 = -1
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[y * info.width + x] < 100) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}
const near = (actual, expected, tolerance = 4) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} ± ${tolerance}`)

for (const [angle, mimeType] of [
  [90, 'image/png'],
  [180, 'image/png'],
  [270, 'image/png'],
  [7, 'image/png'],
  [-11, 'image/png'],
  [7, 'application/pdf'],
  [90, 'application/pdf'],
]) {
  test(`OCR corrects ${angle}° ${mimeType} and maps Russian/English evidence to original pixels`, async () => {
    const { data: original, info } = await sharp(upright)
      .rotate(angle, { background: '#fff' })
      .png()
      .toBuffer({ resolveWithObject: true })
    const radians = (angle * Math.PI) / 180
    const originalVertices = corners(49, 59, 182, 72).map(({ x, y }) => ({
      x: Math.cos(radians) * (x - 150) - Math.sin(radians) * (y - 200) + info.width / 2,
      y: Math.sin(radians) * (x - 150) + Math.cos(radians) * (y - 200) + info.height / 2,
    }))
    const provider = new GoogleVisionOcrProvider({
      keyFile: 'unused',
      renderDpi: 72,
      languageHints: ['en', 'ru'],
    })
    let calls = 0
    provider.client = {
      async documentTextDetection({ image, imageContext }) {
        calls++
        assert.deepEqual(imageContext.languageHints, ['en', 'ru'])
        if (calls === 1) return [response(originalVertices)]
        assert.equal(calls, 2)
        const ink = await inkBounds(image.content)
        near(ink.width, 182, 3)
        near(ink.height, 72, 3)
        return [response(corners(ink.x, ink.y, ink.width, ink.height))]
      },
    }
    let input = original
    if (mimeType === 'application/pdf') {
      const pdf = await PDFDocument.create(),
        image = await pdf.embedPng(original)
      pdf
        .addPage([info.width, info.height])
        .drawImage(image, { x: 0, y: 0, width: info.width, height: info.height })
      input = Buffer.from(await pdf.save())
    }
    const {
      pages: [page],
    } = await provider.recognize(input, mimeType)
    assert.equal(calls, 2)
    assert.equal(page.providerCalls, 2)
    assert.equal(page.width, info.width)
    assert.equal(page.height, info.height)
    assert.equal(page.text, labels.join(' '))
    const expected = await inkBounds(original),
      actual = page.blocks[0].bbox
    near(actual.x * info.width, expected.x)
    near(actual.y * info.height, expected.y)
    near(actual.width * info.width, expected.width)
    near(actual.height * info.height, expected.height)
  })
}

test('uncertain or mixed text directions do not trigger speculative rotation', async () => {
  for (const uncertain of [true, false]) {
    const provider = new GoogleVisionOcrProvider({
      keyFile: 'unused',
      renderDpi: 72,
      languageHints: [],
    })
    let calls = 0
    const result = response(
      [
        { x: 100, y: 50 },
        { x: 100, y: 230 },
        { x: 30, y: 230 },
        { x: 30, y: 50 },
      ],
      uncertain ? 0.3 : 0.99,
    )
    if (!uncertain) {
      const word = result.fullTextAnnotation.pages[0].blocks[0].paragraphs[0].words[1]
      word.boundingBox.vertices = [
        ...word.boundingBox.vertices.slice(2),
        ...word.boundingBox.vertices.slice(0, 2),
      ]
    }
    provider.client = {
      async documentTextDetection() {
        calls++
        return [result]
      },
    }
    const {
      pages: [page],
    } = await provider.recognize(upright, 'image/png')
    assert.equal(calls, 1)
    assert.equal(page.rotationDegrees, 0)
  }
})

test('blank detection preserves sparse and faint text and improves low contrast only when needed', async () => {
  const blank = await sharp({
    create: { width: 600, height: 800, channels: 3, background: '#ddd' },
  })
    .png()
    .toBuffer()
  assert.equal((await normalizeImage(blank)).blank, true)
  const faint = await sharp(blank)
    .composite([
      {
        input: Buffer.from(
          '<svg width="600" height="800"><rect x="50" y="60" width="10" height="4" fill="#bbb"/></svg>',
        ),
      },
    ])
    .png()
    .toBuffer()
  const normalized = await normalizeImage(faint)
  assert.equal(normalized.blank, false)
  const before = await sharp(faint).stats(),
    after = await sharp(normalized.png).stats()
  assert.ok(
    after.channels[0].max - after.channels[0].min > before.channels[0].max - before.channels[0].min,
  )
  const transparent = await sharp({
    create: { width: 30, height: 40, channels: 4, background: '#0000' },
  })
    .png()
    .toBuffer()
  assert.equal((await normalizeImage(transparent)).blank, true)
})

test('PDF blank middle page retains numbering and never reaches the external OCR', async () => {
  const pdf = await PDFDocument.create()
  const image = await pdf.embedPng(upright)
  for (let i = 0; i < 3; i++) {
    const page = pdf.addPage([300, 400])
    if (i !== 1) page.drawImage(image, { x: 0, y: 0, width: 300, height: 400 })
  }
  const buffer = Buffer.from(await pdf.save())
  assert.equal((await inspect(buffer, 'application/pdf')).ok, true)
  const provider = new GoogleVisionOcrProvider({
    keyFile: 'unused',
    renderDpi: 72,
    languageHints: [],
  })
  let calls = 0
  provider.client = {
    async documentTextDetection() {
      calls++
      return [response(corners(49, 59, 182, 72))]
    },
  }
  const { pages } = await provider.recognize(buffer, 'application/pdf')
  assert.deepEqual(
    pages.map((page) => page.pageNumber),
    [1, 2, 3],
  )
  assert.deepEqual(
    pages.map((page) => page.sentToProvider),
    [true, false, true],
  )
  assert.equal(pages[1].text, '')
  assert.equal(calls, 2)
})

test('all eight JPEG and PNG EXIF orientations agree with the actual viewer and mock OCR dimensions', async () => {
  for (const format of ['jpeg', 'png']) {
    for (let orientation = 1; orientation <= 8; orientation++) {
      const buffer = await sharp(upright)
        .withMetadata({ orientation, density: 72 })
        .toFormat(format)
        .toBuffer()
      const normalized = await normalizeImage(buffer)
      const mock = await new MockOcrProvider().recognize(buffer, `image/${format}`)
      assert.equal(mock.pages[0].width, normalized.width)
      assert.equal(mock.pages[0].height, normalized.height)
      const rendered = await new PageRenderService({ getBuffer: async () => buffer }).render(
        'test',
        `image/${format}`,
        1,
        normalized.width,
      )
      const renderedMeta = await sharp(rendered).metadata()
      assert.equal(renderedMeta.width, normalized.width)
      assert.equal(renderedMeta.height, normalized.height)
      const a = await inkBounds(normalized.png),
        b = await inkBounds(rendered)
      for (const key of ['x', 'y', 'width', 'height']) near(a[key], b[key], 1)
    }
  }
})

test('PDF crop boxes and page rotation match the original viewer coordinate system', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([600, 800])
  page.setCropBox(100, 150, 300, 400)
  page.drawRectangle({ x: 130, y: 210, width: 100, height: 30, color: rgb(0, 0, 0) })
  page.node.set(PDFName.of('Rotate'), pdf.context.obj(90))
  const buffer = Buffer.from(await pdf.save())
  const [raster] = await Array.fromAsync(rasterizePdf(buffer, 72))
  const rendered = await new PageRenderService({ getBuffer: async () => buffer }).render(
    'test',
    'application/pdf',
    1,
    raster.width,
  )
  assert.deepEqual(await inkBounds(raster.png), await inkBounds(rendered))
})

test('inspection rejects empty, mismatched, broken, password-protected and later-page corrupted PDFs', async () => {
  assert.equal((await inspect(Buffer.alloc(0), 'application/pdf')).code, 'empty_file')
  assert.equal((await inspect(upright, 'application/pdf')).code, 'content_mismatch')
  assert.equal((await inspect(Buffer.from('%PDF broken'), 'application/pdf')).ok, false)
  assert.equal((await inspect(Buffer.from([0xff, 0xd8, 0xff, 0]), 'image/jpeg')).ok, false)
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400]).drawText('Valid first page')
  const second = pdf.addPage([300, 400])
  const badStream = pdf.context.stream(Buffer.from('not a zlib stream'), { Filter: 'FlateDecode' })
  second.node.set(PDFName.of('Contents'), pdf.context.register(badStream))
  const corrupted = Buffer.from(await pdf.save({ useObjectStreams: false }))
  const result = await inspect(corrupted, 'application/pdf')
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, 'corrupted_pdf')
  const encrypted = await readFile('scripts/fixtures/password-protected.pdf')
  assert.equal((await inspect(encrypted, 'application/pdf')).code, 'password_protected')
})

test('browser uploads send only metadata above the limit, including replacement attempts', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return Response.json({ status: 'rejected' })
  })
  const large = new File([new Uint8Array(UPLOAD_MAX_BYTES + 1)], 'большой.pdf', {
    type: 'application/pdf',
  })
  for (const replaces of [undefined, 'existing-document']) {
    await uploadFile(large, replaces)
    const { url, options } = calls.at(-1)
    assert.equal(url, '/api/documents/oversized')
    assert.equal(typeof options.body, 'string')
    assert.deepEqual(JSON.parse(options.body), {
      filename: large.name,
      mimeType: large.type,
      sizeBytes: large.size,
    })
  }
  const boundary = new File([new Uint8Array(UPLOAD_MAX_BYTES)], 'boundary.pdf', {
    type: 'application/pdf',
  })
  await uploadFile(boundary, 'existing-document')
  assert.equal(calls.at(-1).url, '/api/documents/existing-document/file')
  assert.equal(calls.at(-1).options.body.get('file').size, UPLOAD_MAX_BYTES)
})
