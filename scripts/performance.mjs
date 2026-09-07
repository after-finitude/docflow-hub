import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { cpus, totalmem, platform, release } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { Queue } from 'bullmq'
import { chromium } from 'playwright-core'
import { evaluationClient } from './eval-client.mjs'
import { median } from './eval-metrics.mjs'

const web = process.env.EVAL_WEB_URL
if (!web || !process.env.EVAL_REDIS_URL || !process.env.EVAL_ENVIRONMENT)
  throw new Error(
    'Set EVAL_WEB_URL, EVAL_REDIS_URL and EVAL_ENVIRONMENT for the disposable benchmark stack',
  )
const client = await evaluationClient()
const runtime = await client.json('/documents/review-metrics')
const manifest = JSON.parse(await readFile('evaluation/dataset/ground-truth.json'))
const report = {
  startedAt: new Date().toISOString(),
  providers: runtime.providers,
  concurrency: runtime.concurrency,
  environment: {
    description: process.env.EVAL_ENVIRONMENT,
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
  },
  existingDocuments: (await client.json('/documents?pageSize=1')).total,
  processing: [],
  load: {},
  display: {},
}
const onePage = await readFile('evaluation/dataset/invoice-001.pdf')
const tenPages = await PDFDocument.load(onePage)
const font = await tenPages.embedFont(StandardFonts.Helvetica)
for (let page = 2; page <= 10; page++)
  tenPages
    .addPage([595, 842])
    .drawText(
      `Attachment page ${page}\nSupporting delivery details for the invoice.\nQuantity and payment conditions follow the original agreement.`,
      { font, size: 12, x: 40, y: 780, lineHeight: 20 },
    )
const tenPageBytes = await tenPages.save()
assert.equal((await PDFDocument.load(tenPageBytes)).getPageCount(), 10)
for (const [pages, bytes] of [
  [1, onePage],
  [10, tenPageBytes],
]) {
  const samples = []
  for (let i = 0; i < 3; i++) {
    const result = await client.settle(await client.upload(`benchmark-${pages}-pages.pdf`, bytes))
    samples.push({
      id: result.id,
      status: result.status,
      pageCount: result.pageCount,
      elapsedMs: result.elapsedMs,
      error: result.error ?? null,
    })
  }
  report.processing.push({
    pages,
    samples,
    medianMs: median(samples.map((s) => s.elapsedMs)),
    maxMs: Math.max(...samples.map((s) => s.elapsedMs)),
  })
}

const redis = new URL(process.env.EVAL_REDIS_URL)
const connection = {
  host: redis.hostname,
  port: Number(redis.port || 6379),
  username: redis.username || undefined,
  password: redis.password || undefined,
  db: Number(redis.pathname.slice(1) || 0),
  ...(redis.protocol === 'rediss:' ? { tls: {} } : {}),
}
const queues = ['preprocess', 'ocr', 'classify', 'extract', 'validate'].map(
  (name) => new Queue(name, { connection }),
)
const snapshots = []
const sampling = { active: true }
const sampleQueues = async () => {
  while (sampling.active) {
    snapshots.push({
      at: new Date().toISOString(),
      queues: Object.fromEntries(
        await Promise.all(
          queues.map(async (queue) => [
            queue.name,
            await queue.getJobCounts('active', 'wait', 'delayed', 'failed'),
          ]),
        ),
      ),
    })
    await delay(100)
  }
}
try {
  const sampler = sampleQueues()
  const start = performance.now()
  try {
    const files = manifest.documents
      .filter((d) => d.expectedType && !d.multiDocument && d.file.endsWith('.pdf'))
      .slice(0, 20)
    assert.equal(files.length, 20)
    const results = await Promise.all(
      files.map(async (entry) => {
        try {
          const result = await client.settle(
            await client.upload(`evaluation/dataset/${entry.file}`),
          )
          return {
            file: entry.file,
            id: result.id,
            status: result.status,
            elapsedMs: result.elapsedMs,
            error: result.error ?? null,
          }
        } catch (error) {
          return { file: entry.file, status: 'failed', elapsedMs: null, error: error.message }
        }
      }),
    )
    report.load = {
      submitted: files.length,
      elapsedMs: Math.round(performance.now() - start),
      medianMs: median(results.filter((r) => r.elapsedMs !== null).map((r) => r.elapsedMs)),
      results,
    }
  } finally {
    sampling.active = false
    await sampler
  }
  report.load.queueSnapshots = snapshots
  report.load.peak = Object.fromEntries(
    queues.map((queue) => [
      queue.name,
      Object.fromEntries(
        ['active', 'wait', 'delayed', 'failed'].map((state) => [
          state,
          Math.max(...snapshots.map((s) => s.queues[queue.name][state] ?? 0)),
        ]),
      ),
    ]),
  )
  report.load.final = Object.fromEntries(
    await Promise.all(
      queues.map(async (queue) => [
        queue.name,
        await queue.getJobCounts('active', 'wait', 'delayed', 'failed'),
      ]),
    ),
  )
} finally {
  await Promise.all(queues.map((queue) => queue.close()))
}

const browser = await chromium.launch(
  process.env.EVAL_CHROME_PATH
    ? { executablePath: process.env.EVAL_CHROME_PATH }
    : { channel: 'chrome' },
)
try {
  const auth = await browser.newContext()
  const loginPage = await auth.newPage()
  await loginPage.goto(`${web}/login`)
  await loginPage.fill('input[name="login"]', process.env.EVAL_LOGIN)
  await loginPage.fill('input[name="password"]', process.env.EVAL_PASSWORD)
  await loginPage.click('button[type="submit"]')
  await loginPage.waitForURL('**/inbox')
  const storageState = await auth.storageState()
  await auth.close()
  const samples = []
  for (const group of report.processing) {
    for (const document of group.samples) {
      const context = await browser.newContext({
        storageState,
        viewport: { width: 1440, height: 900 },
      })
      const page = await context.newPage()
      const opening =
        document.status === 'needs_review'
          ? page.waitForResponse(
              (r) => r.url().endsWith('/review-opened') && r.request().method() === 'POST',
            )
          : null
      await page.goto(`${web}/documents/${document.id}`)
      await page.waitForFunction(
        () => performance.getEntriesByName('docflow-review-ready').length > 0,
      )
      const measured = await page.evaluate(() => ({
        readyMs: Math.round(performance.getEntriesByName('docflow-review-ready')[0].startTime),
        ttfbMs: Math.round(performance.getEntriesByType('navigation')[0].responseStart),
        imageLoaded: [...document.images].some(
          (img) => img.alt === 'Page 1' && img.complete && img.naturalWidth > 0,
        ),
        fieldCount: [...document.querySelectorAll('button')].filter((button) =>
          button.textContent.startsWith('Show in document'),
        ).length,
      }))
      assert.equal(measured.imageLoaded, true)
      assert.ok(measured.fieldCount > 0, 'Fields must be rendered before recording display time')
      if (opening) assert.equal((await opening).ok(), true)
      samples.push({ id: document.id, pages: group.pages, ...measured })
      await context.close()
    }
  }
  report.display = {
    browser: browser.version(),
    viewport: '1440x900',
    context:
      'Fresh browser context per full navigation; empty HTTP cache; warm API/worker/web processes and shared server caches; no CPU/network throttling. Mark recorded after hydration and first-page image load with fields rendered.',
    samples,
    medianMs: median(samples.map((s) => s.readyMs)),
    maxMs: Math.max(...samples.map((s) => s.readyMs)),
  }
} finally {
  await browser.close()
}

report.finishedAt = new Date().toISOString()
report.review = (
  await client.json(`/documents/review-metrics?since=${encodeURIComponent(report.startedAt)}`)
).review
const outcomes = [...report.processing.flatMap((g) => g.samples), ...report.load.results]
report.failures = outcomes.filter((r) => !['approved', 'needs_review'].includes(r.status))
const lines = [
  '# Performance evaluation',
  '',
  `Run: ${report.startedAt}`,
  `Environment: ${JSON.stringify(report.environment)}.`,
  `Providers: ${JSON.stringify(report.providers)}. API configuration: ${JSON.stringify(report.concurrency)}; the worker must use the same environment.`,
  '',
  '**Mock providers measure local pipeline overhead, not external-provider latency.**',
  '',
  `${report.existingDocuments} documents existed before this run. Repeated corpus uploads exercise normal duplicate/uniqueness checks; decisions may require review. No data is reset by this script.`,
  '',
  '## Upload to decision',
  '',
  'Three sequential uploads per size. The ten-page fixture has one invoice page and nine nonblank text attachments, not ten dense/scanned invoice pages. Durations include upload and polling (100 ms interval); all individual outcomes are in JSON.',
  '',
  '| Pages | Samples | Median ms | Max ms |',
  '| --- | --- | --- | --- |',
  ...report.processing.map(
    (g) => `| ${g.pages} | ${g.samples.length} | ${g.medianMs} | ${g.maxMs} |`,
  ),
  '',
  '## 20 simultaneous uploads',
  '',
  `Submitted ${report.load.submitted}; total completion ${report.load.elapsedMs} ms; per-document median ${report.load.medianMs} ms. Failures across sequential and load cases: ${report.failures.length}.`,
  '',
  `Peak sampled queue counts: ${JSON.stringify(report.load.peak)}.`,
  `Final queue counts: ${JSON.stringify(report.load.final)}.`,
  'Queue counts are read directly from BullMQ every 100 ms plus Redis response time; short peaks may be missed. Sampling overhead is included.',
  '',
  '## First page and fields',
  '',
  report.display.context,
  `Chrome ${report.display.browser}; ${report.display.viewport}; ${report.display.samples.length} samples; median ${report.display.medianMs} ms, max ${report.display.maxMs} ms.`,
  '',
  '## Review time',
  '',
  `Manual approvals: ${report.review.approvals}; measured: ${report.review.measured}; median: ${report.review.medianMs ?? 'not measured'} ms. Browser openings verify instrumentation; this unattended benchmark does not simulate human review. The PostgreSQL/API regression test verifies timestamp pairing and median calculation.`,
  '',
  'Real-provider latency and human review time remain deferred. These small localhost samples do not establish production p95 or capacity.',
  '',
]
await writeFile('evaluation/performance.json', JSON.stringify(report, null, 2) + '\n')
await writeFile('evaluation/performance.md', lines.join('\n'))
assert.equal(
  report.failures.length,
  0,
  'Some documents did not reach a successful decision; see report',
)
console.log(
  `Processing and 20-upload benchmark complete; display median ${report.display.medianMs} ms`,
)
