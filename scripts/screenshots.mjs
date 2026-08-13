// Съёмка экранов из состава поставки (ТЗ §16): Review Workspace,
// Execution Log с повтором упавшей задачи, отчёт evaluation.
//
// Скрипт управляет браузером, уже установленным в системе (channel: 'chrome'),
// и ничего не скачивает — то же решение, что и в генераторе демо-набора.
// Требует поднятый стек: docker compose up -d --wait
//
//   node scripts/screenshots.mjs [адрес]

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

/** Документ на проверке: поля, уверенность, подсвеченная область-источник. */
async function reviewWorkspace() {
  const response = await page.request.get(`${baseUrl}/api/documents?status=needs_review&pageSize=1`)
  const { items } = await response.json()
  if (!items?.length) throw new Error('Нет документа в статусе needs_review')

  await page.goto(`${baseUrl}/documents/${items[0].id}`)
  await page.waitForSelector('img[alt*="Страница"]', { timeout: 15_000 })
  // «Показать в документе» подсвечивает область-источник в оригинале —
  // именно это и должен показывать скриншот (критерий приёмки 5).
  const link = page.getByRole('button', { name: /Показать в документе/ }).first()
  if (await link.count()) await link.click()
  await page.waitForTimeout(1200)
  await shot('review-workspace')
}

/** Журнал выполнения: упавший этап раскрыт, видны ошибка, стек и повтор. */
async function executionLog() {
  await page.goto(`${baseUrl}/runs`)
  await page.getByText('только ошибки').click()
  await page.waitForTimeout(1500)

  const expand = page.getByRole('button', { name: 'Подробнее' }).first()
  if (await expand.count()) {
    await expand.click()
    await page.waitForTimeout(600)
  }
  await shot('execution-log')
}

/** Отчёт evaluation: тот же файл, что лежит в репозитории. */
async function evaluationReport() {
  const report = await readFile(join(root, 'evaluation/last-run.md'), 'utf8')
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 48px; background: #fff; color: #171717;
           font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre { margin: 0; white-space: pre-wrap; }
  </style><pre>${report.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>`

  // Промежуточная страница живёт во временном каталоге: в поставку идёт
  // только снимок.
  const file = join(tmpdir(), 'docflow-evaluation-report.html')
  await writeFile(file, html)
  await page.goto(`file://${file}`)
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(outputDir, 'evaluation-report.png'), fullPage: true })
  console.log('  evaluation-report.png')
}

try {
  console.log(`Съёмка с ${baseUrl}:`)
  await login()
  await reviewWorkspace()
  await executionLog()
  await evaluationReport()
} finally {
  await browser.close()
}
