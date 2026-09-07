import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { SESSION_COOKIE_NAME } from '@docflow/shared'

const fixture = (id, status, value = '100') => ({
  id,
  originalFilename: `review-${id}.pdf`,
  mimeType: 'application/pdf',
  sizeBytes: 100,
  hasOriginal: true,
  sourceType: 'upload',
  documentType: 'invoice',
  typeConfidence: 0.95,
  status,
  statusReason: null,
  minCriticalConfidence: 0.95,
  blockingIssues: 0,
  warningIssues: 0,
  hasThumbnail: false,
  duplicateOfId: null,
  versionNumber: 1,
  previousVersionId: null,
  isActive: true,
  currentStep: 'ocr',
  currentStepState: 'running',
  receivedAt: new Date().toISOString(),
  schemaVersionId: null,
  schemaVersion: 1,
  checksum: 'test',
  sourcePath: null,
  processedAt: null,
  pageCount: 1,
  issues: [],
  exports: [],
  canApprove: status === 'needs_review',
  thresholds: { autoClassify: 0.7, criticalFieldConfidence: 0.8, fieldConfidence: 0.6 },
  fields:
    status === 'processing'
      ? []
      : [
          {
            name: 'grand_total',
            label: 'Grand total',
            valueType: 'number',
            rawValue: value,
            normalizedValue: Number(value),
            confidence: 0.95,
            confidenceReason: null,
            sourcePage: 1,
            sourceBbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 },
            sourceFound: true,
            isCritical: true,
            isRequired: true,
            isEdited: false,
          },
        ],
})

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

// Real Next/React UI, isolated HTTP responses: no database, credentials or paid providers.
test(
  'review updates in place after recognition, retries status failures and stops before manual edits',
  { timeout: 180000 },
  async (t) => {
    const generatedFiles = new Map()
    for (const file of ['apps/web/next-env.d.ts', 'apps/web/AGENTS.md', 'apps/web/CLAUDE.md'])
      generatedFiles.set(
        file,
        await readFile(file).catch((error) => {
          if (error.code === 'ENOENT') return null
          throw error
        }),
      )
    let current = fixture('first', 'processing'),
      reads = 0,
      failReads = false
    const opened = [],
      requests = []
    const api = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://test').pathname
      requests.push(`${request.method} ${path}`)
      const json = (data, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(data))
      }
      if (path === '/auth/me') return json({ id: 'test', login: 'operator', role: 'operator' })
      if (path.endsWith('/pages/1/image')) {
        response.writeHead(200, { 'Content-Type': 'image/svg+xml' })
        return response.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="white"/><text x="60" y="100">Total</text></svg>',
        )
      }
      if (path.endsWith('/review-opened')) {
        opened.push(current.id)
        return json({})
      }
      if (request.method === 'GET' && path === `/documents/${current.id}`) {
        reads++
        return json(failReads ? { message: 'temporary outage' } : current, failReads ? 503 : 200)
      }
      if (request.method === 'POST' && /\/(reprocess|type)$/.test(path)) {
        current = { ...current, status: 'processing', currentStep: 'extraction', canApprove: false }
        return json(current)
      }
      if (request.method === 'POST' && path.endsWith('/file')) {
        request.resume()
        current = fixture('replacement', 'processing')
        return json({ id: current.id }, 201)
      }
      return json({ message: 'Unexpected test request' }, 404)
    })
    const apiPort = await listen(api)
    const reserve = createServer(),
      webPort = await listen(reserve)
    await new Promise((resolve) => reserve.close(resolve))
    const base = `http://127.0.0.1:${webPort}`
    const web = spawn(
      process.execPath,
      [
        '../../node_modules/next/dist/bin/next',
        'dev',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(webPort),
      ],
      {
        cwd: 'apps/web',
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
          NEXT_TELEMETRY_DISABLED: '1',
        },
      },
    )
    let logs = '',
      browser
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Next startup timed out')), 60000)
        const log = (chunk) => {
          logs = (logs + chunk).slice(-12000)
          if (logs.includes('Ready in')) {
            clearTimeout(timeout)
            resolve()
          }
        }
        web.stdout.on('data', log)
        web.stderr.on('data', log)
        web.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        web.once('exit', (code) => {
          clearTimeout(timeout)
          reject(new Error(`Next exited: ${code}`))
        })
      })
      browser = await chromium.launch(
        process.env.EVAL_CHROME_PATH
          ? { executablePath: process.env.EVAL_CHROME_PATH }
          : { channel: 'chrome' },
      )
      const context = await browser.newContext()
      await context.addCookies([{ name: SESSION_COOKIE_NAME, value: 'isolated-test', url: base }])
      const page = await context.newPage()
      page.setDefaultTimeout(10000)
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      const hasValue = (value) =>
        page.waitForFunction(
          (expected) => document.querySelector('#field-grand_total')?.value === expected,
          value,
        )
      const processing = () =>
        page.locator('header').getByText('Processing', { exact: true }).waitFor()
      await page.goto(`${base}/documents/first`, { timeout: 60000 })
      await processing()
      current = fixture('first', 'needs_review', '120')
      await hasValue('120')
      assert.equal(page.url(), `${base}/documents/first`)
      await page.waitForFunction(() => !document.querySelector('#field-grand_total')?.disabled)
      await page.getByRole('button', { name: 'Approve', exact: true }).waitFor()
      assert.equal(
        await page.getByRole('button', { name: 'Approve', exact: true }).isEnabled(),
        true,
      )
      assert.ok(opened.includes('first'), 'Finishing in-place starts the review-time record')

      // Polling must stop once fields can be edited; a dirty value must survive.
      const settledReads = reads
      await page.locator('#field-grand_total').fill('123')
      await delay(2500)
      assert.equal(reads, settledReads)
      assert.equal(await page.locator('#field-grand_total').inputValue(), '123')
      await page.locator('#field-grand_total').fill('120')
      await page.locator('#field-grand_total').press('Tab')

      await page.getByRole('button', { name: 'Reprocess', exact: true }).click()
      await processing()
      failReads = true
      await page.getByRole('status').filter({ hasText: 'Retrying automatically' }).waitFor()
      failReads = false
      current = fixture('first', 'needs_review', '140')
      await hasValue('140')
      assert.equal(page.url(), `${base}/documents/first`)

      await page.getByRole('combobox', { name: /Document type/ }).selectOption('contract')
      await processing()
      current = { ...fixture('first', 'needs_review', '160'), documentType: 'contract' }
      await hasValue('160')
      assert.equal(
        await page.getByRole('combobox', { name: /Document type/ }).inputValue(),
        'contract',
      )

      // Replacement uses client navigation to another id in the same dynamic route.
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Replace file', exact: true }).click()
      await (
        await chooser
      ).setFiles({
        name: 'replacement.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-test'),
      })
      await page.waitForURL(`${base}/documents/replacement`)
      await processing()
      current = fixture('replacement', 'needs_review', '180')
      await hasValue('180')
      assert.equal(await page.locator('h1').textContent(), 'review-replacement.pdf')
      assert.ok(requests.includes('POST /documents/first/reprocess'))
      assert.ok(requests.includes('POST /documents/first/type'))
      assert.ok(requests.includes('POST /documents/first/file'))
      assert.deepEqual(pageErrors, [])
    } catch (error) {
      t.diagnostic(logs)
      throw error
    } finally {
      await browser?.close()
      if (web.exitCode === null) {
        const stopped = new Promise((resolve) => web.once('exit', resolve))
        process.kill(-web.pid, 'SIGTERM')
        await stopped
      }
      for (const [file, original] of generatedFiles)
        if (original === null) await rm(file, { force: true })
        else await writeFile(file, original)
      api.closeAllConnections()
      await new Promise((resolve) => api.close(resolve))
    }
  },
)
