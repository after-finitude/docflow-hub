import 'reflect-metadata'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { assessOcrQuality } from '@docflow/shared'
import { OpenRouterOcrProvider } from '../apps/worker/dist/ocr/openrouter-ocr.provider.js'
import { OpenAiCompatibleLlmProvider } from '../apps/worker/dist/llm/openai-compatible-llm.provider.js'

const options = {
  baseUrl: 'https://openrouter.invalid/api/v1',
  apiKey: 'test-secret',
  model: 'qwen/qwen3-vl-32b-instruct',
  timeoutMs: 1000,
  renderDpi: 72,
}
const image = await sharp(
  Buffer.from(
    '<svg width="300" height="400"><rect width="300" height="400" fill="white"/><text x="20" y="50" font-size="20">Invoice 100</text></svg>',
  ),
)
  .png()
  .toBuffer()
const blocks = { blocks: [{ text: 'Invoice 100', bbox: [50, 70, 700, 140] }] }
const reply = (value, finish_reason = 'stop') =>
  Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason }] })

test('hybrid OCR keeps native text, scans partial text layers, skips blanks and journals original page numbers', async (t) => {
  const pdf = await PDFDocument.create()
  const native = 'Invoice INV-42. Supplier Example. Total USD 100.00. Payment due 2026-10-01.'
  pdf.addPage([600, 800]).drawText(native, { x: 20, y: 700, size: 12 })
  const scanned = pdf.addPage([300, 400])
  scanned.drawImage(await pdf.embedPng(image), { x: 0, y: 0, width: 300, height: 400 })
  scanned.drawText(native, { x: 0, y: 380, size: 3 }) // A header must not hide the underlying scan.
  pdf.addPage([300, 400])
  const events = [],
    requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(events.at(-1).state, 'attempted')
    assert.equal(url, `${options.baseUrl}/chat/completions`)
    assert.equal(init.headers.Authorization, 'Bearer test-secret')
    requests.push(JSON.parse(init.body))
    return reply(blocks)
  })
  const { pages } = await new OpenRouterOcrProvider(options).recognize(
    Buffer.from(await pdf.save()),
    'application/pdf',
    async (event) => events.push(event),
  )
  assert.equal(pages[0].text, native)
  assert.deepEqual(
    pages.map((page) => page.pageNumber),
    [1, 2, 3],
  )
  assert.deepEqual(
    pages.map((page) => page.sentToProvider),
    [false, true, false],
  )
  assert.equal(pages[2].blank, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, options.model)
  assert.equal(requests[0].max_tokens, 16384)
  assert.equal('reasoning' in requests[0], false)
  assert.match(requests[0].messages[1].content[1].image_url.url, /^data:image\/png;base64,/)
  assert.deepEqual(
    events.map(({ state, purpose, pages: sentPages }) => ({ state, purpose, pages: sentPages })),
    [
      { state: 'attempted', purpose: 'ocr', pages: [2] },
      { state: 'succeeded', purpose: 'ocr', pages: [2] },
    ],
  )
  assert.equal(JSON.stringify(events).includes('Invoice'), false)
  assert.deepEqual(pages[1].blocks[0].bbox, { x: 0.05, y: 0.07, width: 0.65, height: 0.07 })
  assert.equal(pages[1].confidence, null)
  assert.deepEqual(
    assessOcrQuality(
      pages.filter((p) => !p.blank).map((p) => ({ ...p, textLength: p.text.length })),
    ).pages,
    [2],
  )
})

test('native-only PDF needs no external request or disclosure event', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Native PDF must stay local'))
  const pdf = await PDFDocument.create()
  pdf.addPage().drawText('Invoice 42 supplier Example amount USD 100.00 payable 2026-10-01')
  const { pages } = await new OpenRouterOcrProvider(options).recognize(
    Buffer.from(await pdf.save()),
    'application/pdf',
    () => assert.fail('No external disclosure'),
  )
  assert.equal(pages[0].confidence, 1)
  assert.equal(pages[0].sentToProvider, false)
})

test('vision rejects invalid boxes, repairs with journaling and keeps EXIF viewer coordinates', async (t) => {
  const events = [],
    requests = []
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    const request = JSON.parse(init.body)
    requests.push(request)
    const imageUrl = request.messages[1].content[1].image_url.url
    const meta = await sharp(Buffer.from(imageUrl.split(',')[1], 'base64')).metadata()
    assert.equal(meta.width, 400)
    assert.equal(meta.height, 300)
    return reply(
      requests.length === 1 ? { blocks: [{ text: 'bad', bbox: [900, 0, 100, 1200] }] } : blocks,
    )
  })
  const rotated = await sharp(image).withMetadata({ orientation: 6 }).jpeg().toBuffer()
  const {
    pages: [page],
  } = await new OpenRouterOcrProvider(options).recognize(rotated, 'image/jpeg', async (event) =>
    events.push(event),
  )
  assert.equal(page.width, 400)
  assert.equal(page.height, 300)
  assert.equal(page.providerCalls, 2)
  assert.equal(page.text, 'Invoice 100')
  assert.equal(requests[1].messages.length, 4)
  assert.deepEqual(
    events.filter((event) => event.state === 'attempted').map((event) => event.attempt),
    [1, 2],
  )
})

test('vision fails closed on audit errors, repeated bad coordinates, truncated replies and HTTP errors', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return reply(blocks)
  })
  const provider = new OpenRouterOcrProvider(options)
  await assert.rejects(
    provider.recognize(image, 'image/png', async () => {
      throw new Error('audit unavailable')
    }),
    /audit unavailable/,
  )
  assert.equal(calls, 0)
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return reply({ blocks: [{ text: 'private', bbox: [-1, 2, 3, 4] }] })
  })
  await assert.rejects(provider.recognize(image, 'image/png'), /response schema errors/)
  assert.equal(calls, 3)
  t.mock.method(globalThis, 'fetch', async () => reply(blocks, 'length'))
  await assert.rejects(provider.recognize(image, 'image/png'), /output token limit/)
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('private provider response', { status: 503 }),
  )
  const events = []
  await assert.rejects(
    provider.recognize(image, 'image/png', async (event) => events.push(event)),
    { message: 'LLM API returned HTTP 503' },
  )
  assert.deepEqual(
    events.map((event) => event.state),
    ['attempted', 'failed'],
  )
})

test('Gemini classification uses the same OpenRouter endpoint and key with its own model', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, `${options.baseUrl}/chat/completions`)
    assert.equal(init.headers.Authorization, 'Bearer test-secret')
    assert.equal(JSON.parse(init.body).model, 'google/gemini-2.5-flash-lite')
    return reply({
      document_type: 'invoice',
      confidence: 0.95,
      alternatives: [],
      multi_document_suspected: false,
    })
  })
  const result = await new OpenAiCompatibleLlmProvider({
    ...options,
    model: 'google/gemini-2.5-flash-lite',
  }).classify({ pagesText: [{ page: 1, text: 'Invoice 100' }] })
  assert.equal(result.document_type, 'invoice')
})

test('optional reasoning can be disabled for both vision OCR and text extraction', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    requests.push(JSON.parse(init.body))
    return reply(requests.length === 1 ? blocks : { fields: [] })
  })
  const configured = { ...options, reasoningEffort: 'none' }
  await new OpenRouterOcrProvider(configured).recognize(image, 'image/png')
  await new OpenAiCompatibleLlmProvider(configured).extract({
    documentType: 'invoice',
    fields: [],
    pagesText: [{ page: 1, text: 'Invoice 100' }],
  })
  assert.deepEqual(requests.map(({ reasoning }) => reasoning), [
    { effort: 'none' },
    { effort: 'none' },
  ])
})
