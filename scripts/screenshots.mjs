// Real UI delivery capture. Run immediately after security-live on a disposable mock stack.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluationClient } from './eval-client.mjs'

assert.equal(process.env.EVAL_DISPOSABLE, '1', 'Set EVAL_DISPOSABLE=1 for an isolated stack')
const base = process.env.EVAL_WEB_URL
assert.ok(
  base && process.env.EVAL_LOGIN && process.env.EVAL_PASSWORD,
  'Set EVAL_WEB_URL, EVAL_LOGIN and EVAL_PASSWORD',
)
const client = await evaluationClient()
const security = JSON.parse(await readFile('evaluation/security.json'))
const fixture = await PDFDocument.create()
const font = await fixture.embedFont(StandardFonts.Helvetica)
const sheet = fixture.addPage([595, 842])
const today = new Date().toISOString().slice(0, 10)
const lines = [
  'INVOICE',
  'Supplier: Example Services Ltd',
  `Invoice No: DEMO-${Date.now()}`,
  `Date: ${today}`,
  'Currency: USD',
  'Consulting  x1  100.00',
  'Subtotal: 100.00',
  'Tax: 20.00',
  'Total: 130.00',
]
lines.forEach((line, index) => sheet.drawText(line, { font, size: 14, x: 55, y: 780 - index * 30 }))
const review = await client.settle(
  await client.upload('demo-review.pdf', Buffer.from(await fixture.save())),
)
assert.equal(review.status, 'needs_review')
const failedRuns = (await client.json('/runs?onlyErrors=true&pageSize=100')).items
assert.ok(
  failedRuns.some((run) => run.documentId === security.retryDocumentId),
  'Run security-live first to prepare a failed stage',
)
const output = 'docs/screenshots'
await mkdir(output, { recursive: true })
const browser = await chromium.launch(
  process.env.EVAL_CHROME_PATH
    ? { executablePath: process.env.EVAL_CHROME_PATH }
    : { channel: 'chrome' },
)
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  recordVideo: { dir: 'docs', size: { width: 1440, height: 900 } },
})
const page = await context.newPage()
page.setDefaultTimeout(15000)
const video = page.video()
const started = Date.now()
const until = (seconds) => page.waitForTimeout(Math.max(0, started + seconds * 1000 - Date.now()))
const shot = (name, fullPage = false) =>
  page.screenshot({ path: join(output, `${name}.png`), fullPage })
try {
  await page.goto(`${base}/login`)
  await page.locator('input[name="login"]').fill(process.env.EVAL_LOGIN)
  await page.locator('input[name="password"]').fill(process.env.EVAL_PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL('**/inbox')
  await until(6)
  await page.goto(`${base}/documents/${review.id}`)
  await page.locator('img[alt*="Page"]').waitFor()
  const total = page.locator('#field-grand_total')
  await total
    .locator('../..')
    .getByRole('button', { name: /Show in document/ })
    .click()
  assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), true)
  await until(14)
  await shot('review-workspace')
  const detail = await client.json(`/documents/${review.id}`)
  const value = (name) => Number(detail.fields.find((f) => f.name === name).normalizedValue)
  const corrected = value('subtotal') + value('tax_total')
  assert.ok(Number.isFinite(corrected))
  await total.fill(String(corrected))
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/fields/grand_total') && r.request().method() === 'PATCH',
  )
  await total.press('Tab')
  assert.equal((await saved).ok(), true)
  await until(24)
  const approved = page.waitForResponse(
    (r) => r.url().endsWith('/approve') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  assert.equal((await approved).ok(), true)
  await until(34)
  const exported = page.waitForResponse(
    (r) => r.url().endsWith('/export') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: /Export to JSON/ }).click()
  assert.equal((await exported).ok(), true)
  const final = await client.json(`/documents/${review.id}`)
  assert.equal(final.status, 'exported')
  await until(44)
  await page.goto(`${base}/runs`)
  const filtered = page.waitForResponse((r) => r.url().includes('/api/runs?onlyErrors=true'))
  await page.getByText('errors only', { exact: true }).click()
  assert.equal((await filtered).ok(), true)
  const failedRow = page
    .locator('tr')
    .filter({ has: page.locator(`a[href="/documents/${security.retryDocumentId}"]`) })
  await failedRow.getByRole('button', { name: 'Details', exact: true }).click()
  await page.getByRole('button', { name: 'Retry stage', exact: true }).waitFor()
  await until(52)
  await shot('execution-log', true)
  await page.getByRole('button', { name: 'Retry stage', exact: true }).scrollIntoViewIfNeeded()
  const retried = page.waitForResponse(
    (r) => r.url().endsWith('/retry') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Retry stage', exact: true }).click()
  assert.equal((await retried).ok(), true)
  const recovered = await client.settle({ id: security.retryDocumentId, start: performance.now() })
  assert.ok(!['failed', 'received', 'processing'].includes(recovered.status))
  await until(58)
  await page.goto(`${base}/documents/${security.retryDocumentId}`)
  await page.locator('img[alt*="Page"]').waitFor()
  await until(65)
  const report = await readFile('evaluation/last-run.md', 'utf8')
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:40px;background:white;color:#171717;font:14px/1.6 ui-monospace,monospace}pre{margin:0;white-space:pre-wrap}</style><pre>${report.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>`,
  )
  await page.screenshot({ path: join(output, 'evaluation-report.png'), fullPage: true })
  await until(72)
  await context.close()
  await rename(await video.path(), 'docs/demo.webm')
  await writeFile(
    'evaluation/delivery.json',
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        environment: process.env.EVAL_ENVIRONMENT,
        durationSeconds: Math.round((Date.now() - started) / 1000),
        reviewDocumentId: review.id,
        retryDocumentId: security.retryDocumentId,
        checks: [
          'blocking approval disabled',
          'operator correction saved',
          'approval succeeded',
          'JSON export succeeded',
          'actual failed stage visible',
          'manual retry succeeded',
        ],
        mockProviders: true,
        humanReviewTiming: false,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    'Screenshots and demonstration saved (paced for 72 seconds plus browser capture overhead)',
  )
} finally {
  await browser.close()
}
