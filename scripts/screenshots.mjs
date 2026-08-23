// Capture delivery screenshots (spec §16): Review Workspace, Execution Log,
// and evaluation report.
//
// Use the system Chrome without downloads. Requires docker compose up -d --wait.
//
//   node scripts/screenshots.mjs [address]

import { chromium } from 'playwright-core'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outputDir = join(root, 'docs/screenshots')
const baseUrl = process.argv[2] ?? 'http://localhost:3000'
const viewport = { width: 1440, height: 900 }

const env = Object.fromEntries(
  (await readFile(join(root, '.env'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=')
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
    }),
)

await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({ viewport, deviceScaleFactor: 2 })
const page = await context.newPage()

async function login() {
  await page.goto(`${baseUrl}/login`)
  await page.fill('input[name="login"]', env.SEED_OPERATOR_LOGIN ?? 'operator')
  await page.fill('input[name="password"]', env.SEED_OPERATOR_PASSWORD ?? 'operator_password')
  await page.click('button[type="submit"]')
  await page.waitForURL('**/inbox')
}

async function shot(name) {
  const file = join(outputDir, `${name}.png`)
  await page.screenshot({ path: file })
  console.log(`  ${name}.png`)
}

/** Review document with fields, confidence, and highlighted source area. */
async function reviewWorkspace() {
  const response = await page.request.get(
    `${baseUrl}/api/documents?status=needs_review&hasBlocking=true&pageSize=100`,
  )
  const { items } = await response.json()
  if (!items?.length) throw new Error('No document with needs_review status')

  const document = items.find((item) => item.isActive)
  if (!document) throw new Error('No active document with needs_review status')

  // Revalidate persisted demo data so screenshots never retain messages from
  // an older schema language.
  await page.request.post(`${baseUrl}/api/documents/${document.id}/reprocess`)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const detail = await page.request.get(`${baseUrl}/api/documents/${document.id}`)
    const current = await detail.json()
    if (!['received', 'processing'].includes(current.status)) break
    await page.waitForTimeout(1000)
  }

  await page.goto(`${baseUrl}/documents/${document.id}`)
  await page.waitForSelector('img[alt*="Page"]', { timeout: 15_000 })
  // “Show in document” highlights the source area required by acceptance criterion 5.
  const link = page.getByRole('button', { name: /Show in document/ }).first()
  if (await link.count()) await link.click()
  await page.waitForTimeout(1200)
  await shot('review-workspace')
}

/** Execution Log with a failed stage expanded to show error, stack, and retry. */
async function executionLog() {
  await page.goto(`${baseUrl}/runs`)
  await page.getByText('errors only').click()
  await page.waitForTimeout(1500)

  const expand = page.getByRole('button', { name: 'Details' }).first()
  if (await expand.count()) {
    await expand.click()
    await page.waitForTimeout(600)
  }
  await shot('execution-log')
}

/** Evaluation report from the same file committed to the repository. */
async function evaluationReport() {
  const report = await readFile(join(root, 'evaluation/last-run.md'), 'utf8')
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 48px; background: #fff; color: #171717;
           font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre { margin: 0; white-space: pre-wrap; }
  </style><pre>${report.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>`

  // The temporary page stays outside the delivery; only the screenshot is included.
  const file = join(tmpdir(), 'docflow-evaluation-report.html')
  await writeFile(file, html)
  await page.goto(`file://${file}`)
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(outputDir, 'evaluation-report.png'), fullPage: true })
  console.log('  evaluation-report.png')
}

try {
  console.log(`Capturing from ${baseUrl}:`)
  await login()
  await reviewWorkspace()
  await executionLog()
  await evaluationReport()
} finally {
  await browser.close()
}
