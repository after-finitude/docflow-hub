/**
 * Генератор демонстрационного набора (ТЗ §13).
 *
 * Документы синтетические, реальных персональных данных нет; эталонные
 * значения берутся из данных генератора, поэтому размеченный набор всегда
 * согласован с файлами. Генерация детерминирована (фиксированное зерно),
 * повторный запуск даёт тот же корпус.
 *
 * Отклонение от плана: PDF рисует pdf-lib, а не Playwright из HTML-шаблонов.
 * Причина — Playwright тянет загрузку Chromium (~150 МБ) и внешнюю сеть,
 * а нужного качества макета достаточно и от прямой отрисовки.
 */
import fontkit from '@pdf-lib/fontkit'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, rgb } from 'pdf-lib'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'evaluation', 'dataset')
const fontPath = join(root, 'node_modules', 'dejavu-fonts-ttf', 'ttf', 'DejaVuSans.ttf')
const fontBoldPath = join(root, 'node_modules', 'dejavu-fonts-ttf', 'ttf', 'DejaVuSans-Bold.ttf')

/** Детерминированный ГПСЧ: корпус и эталоны обязаны совпадать при каждом прогоне. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = mulberry32(20260802)
const pick = (list) => list[Math.floor(random() * list.length)]
const between = (min, max) => min + Math.floor(random() * (max - min + 1))

const SUPPLIERS = [
  'Acme GmbH',
  'Globex Ltd',
  'Initech BV',
  'Umbrella SA',
  'Stark Industries',
  'Wayne Enterprises',
  'ООО «Мегастрой»',
  'ООО «Вектор»',
  'Soylent Corp',
  'Hooli Inc',
]
const BANKS = ['Nordbank AG', 'Alpha Banking', 'ПАО «Первый Банк»', 'Meridian Trust']
const AUTHORITIES = ['Federal Tax Office', 'ИФНС № 12 по г. Москве', 'HM Revenue & Customs']
const SUBJECTS = ['Уточнение налоговой базы', 'Request for clarification', 'Payment reminder']
const CONTRACT_SUBJECTS = [
  'Оказание услуг разработки',
  'Supply of office equipment',
  'Consulting services',
]
const CURRENCIES = ['EUR', 'USD', 'GBP']

function pad(value, size = 4) {
  return String(value).padStart(size, '0')
}

function formatDate(date, style) {
  const dd = pad(date.getUTCDate(), 2)
  const mm = pad(date.getUTCMonth() + 1, 2)
  const yyyy = date.getUTCFullYear()
  return style === 'iso' ? `${yyyy}-${mm}-${dd}` : `${dd}.${mm}.${yyyy}`
}

function addDays(date, days) {
  const copy = new Date(date.getTime())
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

/** База отсчёта дат фиксирована: иначе эталон «протухал» бы со временем. */
const BASE_DATE = new Date(Date.UTC(2026, 5, 1))

async function renderPdf(lines, layout) {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const regular = await pdf.embedFont(readFileSync(fontPath), { subset: true })
  const bold = await pdf.embedFont(readFileSync(fontBoldPath), { subset: true })

  const page = pdf.addPage([595, 842])
  const marginX = layout === 'compact' ? 40 : 60
  let y = layout === 'compact' ? 800 : 780

  for (const line of lines) {
    if (line.gap) {
      y -= line.gap
      continue
    }
    if (line.rule) {
      page.drawLine({
        start: { x: marginX, y: y + 6 },
        end: { x: 595 - marginX, y: y + 6 },
        thickness: 0.7,
        color: rgb(0.75, 0.75, 0.75),
      })
      y -= 12
      continue
    }
    const size = line.size ?? (layout === 'compact' ? 10 : 11)
    page.drawText(line.text, {
      x: line.indent ? marginX + line.indent : marginX,
      y,
      size,
      font: line.bold ? bold : regular,
      color: rgb(0.1, 0.1, 0.1),
    })
    y -= size + (layout === 'compact' ? 5 : 9)
  }

  return Buffer.from(await pdf.save())
}

/** Инвойс: три варианта макета, значения и валюта варьируются (ТЗ §13). */
function invoice(index) {
  const supplier = pick(SUPPLIERS)
  const currency = pick(CURRENCIES)
  const layout = pick(['classic', 'compact', 'wide'])
  const number = `INV-${2026}-${pad(1000 + index)}`
  const issued = addDays(BASE_DATE, between(0, 40))
  const due = addDays(issued, pick([14, 30, 45]))

  const subtotal = between(20000, 900000) / 100
  const taxRate = pick([0, 0.07, 0.19, 0.2])
  const tax = Math.round(subtotal * taxRate * 100) / 100
  const total = Math.round((subtotal + tax) * 100) / 100

  const itemCount = between(1, 3)
  const items = Array.from({ length: itemCount }, (_, i) => ({
    description: `Position ${i + 1}`,
    quantity: between(1, 9),
    unit_price: Math.round((subtotal / itemCount) * 100) / 100,
    amount: Math.round((subtotal / itemCount) * 100) / 100,
  }))

  const lines = [
    { text: 'INVOICE', bold: true, size: 18 },
    { gap: 10 },
    { text: `Supplier: ${supplier}` },
    { text: `Invoice No: ${number}` },
    { text: `Date: ${formatDate(issued, 'eu')}` },
    { text: `Due Date: ${formatDate(due, 'eu')}` },
    { text: `Currency: ${currency}` },
    { rule: true },
    ...items.map((item) => ({
      text: `${item.description}  x${item.quantity}  ${item.unit_price.toFixed(2)}`,
      indent: 10,
      size: 9,
    })),
    { rule: true },
    { text: `Subtotal: ${subtotal.toFixed(2)}` },
    { text: `Tax: ${tax.toFixed(2)}` },
    { text: `Total: ${total.toFixed(2)}`, bold: true },
    { gap: 14 },
    { text: 'Payment within terms. Thank you for your business.', size: 8 },
  ]

  return {
    lines,
    layout,
    expectedType: 'invoice',
    critical: {
      supplier_name: supplier,
      invoice_number: number,
      invoice_date: formatDate(issued, 'iso'),
      currency,
      subtotal,
      grand_total: total,
    },
  }
}

function bankStatement(index) {
  const bank = pick(BANKS)
  const currency = pick(CURRENCIES)
  const account = `DE${between(10, 99)} ${between(1000, 9999)} ${between(1000, 9999)}`.replace(
    /\s/g,
    '',
  )
  const from = addDays(BASE_DATE, between(0, 20))
  const to = addDays(from, 30)
  const opening = between(100000, 900000) / 100
  const closing = Math.round((opening + between(-50000, 50000) / 100) * 100) / 100

  return {
    layout: 'classic',
    expectedType: 'bank_statement',
    lines: [
      { text: 'BANK STATEMENT', bold: true, size: 16 },
      { gap: 10 },
      { text: `Bank: ${bank}` },
      { text: `Account: ${account}` },
      { text: `Period From: ${formatDate(from, 'eu')}` },
      { text: `Period To: ${formatDate(to, 'eu')}` },
      { text: `Currency: ${currency}` },
      { rule: true },
      { text: `Opening Balance: ${opening.toFixed(2)}` },
      { text: `Closing Balance: ${closing.toFixed(2)}` },
      { gap: 10 },
      { text: `Statement #${index + 1}`, size: 8 },
    ],
    critical: {
      bank_name: bank,
      account_number: account,
      period_start: formatDate(from, 'iso'),
      period_end: formatDate(to, 'iso'),
      opening_balance: opening,
      closing_balance: closing,
    },
  }
}

function taxLetter(index) {
  const authority = pick(AUTHORITIES)
  const taxpayer = pick(SUPPLIERS)
  const number = `TX-${pad(500 + index)}`
  const date = addDays(BASE_DATE, between(0, 30))
  const amount = between(5000, 200000) / 100

  return {
    layout: 'classic',
    expectedType: 'tax_letter',
    lines: [
      { text: 'TAX NOTICE', bold: true, size: 16 },
      { gap: 10 },
      { text: `Authority: ${authority}` },
      { text: `Letter No: ${number}` },
      { text: `Date: ${formatDate(date, 'eu')}` },
      { text: `Taxpayer: ${taxpayer}` },
      { text: `Taxpayer ID: ${between(1000000000, 9999999999)}` },
      { text: `Subject: ${pick(SUBJECTS)}` },
      { rule: true },
      { text: `Amount Due: ${amount.toFixed(2)}` },
      { text: `Pay By: ${formatDate(addDays(date, 30), 'eu')}` },
    ],
    critical: {
      authority_name: authority,
      letter_number: number,
      letter_date: formatDate(date, 'iso'),
      taxpayer_name: taxpayer,
    },
  }
}

function contract(index) {
  const partyA = pick(SUPPLIERS)
  const partyB = pick(SUPPLIERS.filter((name) => name !== partyA))
  const number = `CT-${pad(300 + index)}`
  const date = addDays(BASE_DATE, between(0, 30))
  const value = between(100000, 5000000) / 100

  return {
    layout: 'wide',
    expectedType: 'contract',
    lines: [
      { text: 'CONTRACT', bold: true, size: 16 },
      { gap: 10 },
      { text: `Contract No: ${number}` },
      { text: `Date: ${formatDate(date, 'eu')}` },
      { text: `Party A: ${partyA}` },
      { text: `Party B: ${partyB}` },
      { text: `Subject: ${pick(CONTRACT_SUBJECTS)}` },
      { text: `Value: ${value.toFixed(2)}` },
      { text: `Currency: ${pick(CURRENCIES)}` },
      { text: `Valid From: ${formatDate(date, 'eu')}` },
      { text: `Valid To: ${formatDate(addDays(date, 365), 'eu')}` },
    ],
    critical: {
      contract_number: number,
      contract_date: formatDate(date, 'iso'),
      party_a: partyA,
      party_b: partyB,
    },
  }
}

/** Скан низкого качества: поворот, шум, падение контраста (ТЗ §13). */
async function degrade(pdfBuffer) {
  const mupdf = await import('mupdf')
  const document = mupdf.Document.openDocument(pdfBuffer, 'application/pdf')
  const pixmap = document
    .loadPage(0)
    .toPixmap(mupdf.Matrix.scale(1.6, 1.6), mupdf.ColorSpace.DeviceRGB, false, true)
  const png = Buffer.from(pixmap.asPNG())

  const meta = await sharp(png).metadata()
  const noise = Buffer.alloc((meta.width ?? 1) * (meta.height ?? 1))
  for (let i = 0; i < noise.length; i++) noise[i] = 110 + Math.floor(random() * 36)

  return sharp(png)
    .rotate(2.5, { background: '#ffffff' })
    .linear(0.72, 30) // падение контраста
    .composite([
      {
        input: noise,
        raw: { width: meta.width ?? 1, height: meta.height ?? 1, channels: 1 },
        blend: 'overlay',
        tile: true,
      },
      // «Рукописная» пометка на полях.
      {
        input: Buffer.from(
          `<svg width="${meta.width}" height="${meta.height}"><text x="${(meta.width ?? 0) * 0.62}" y="${(meta.height ?? 0) * 0.18}" font-family="cursive" font-size="34" fill="#2b4fa2" transform="rotate(-7 ${(meta.width ?? 0) * 0.62} ${(meta.height ?? 0) * 0.18})">оплачено</text></svg>`,
        ),
        blend: 'over',
      },
    ])
    .jpeg({ quality: 62 })
    .toBuffer()
}

async function main() {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const manifest = []
  const perType = { invoice: 12, bank_statement: 9, tax_letter: 9, contract: 9 }
  const builders = { invoice, bank_statement: bankStatement, tax_letter: taxLetter, contract }

  let firstInvoiceFile = null
  let firstInvoiceBytes = null

  for (const [type, count] of Object.entries(perType)) {
    for (let index = 0; index < count; index++) {
      const spec = builders[type](index)
      const bytes = await renderPdf(spec.lines, spec.layout)
      const file = `${type}-${pad(index + 1, 3)}.pdf`
      writeFileSync(join(outDir, file), bytes)

      if (type === 'invoice' && index === 0) {
        firstInvoiceFile = file
        firstInvoiceBytes = bytes
      }

      manifest.push({
        file,
        expectedType: spec.expectedType,
        criticalFields: spec.critical,
        // Размеченный eval-набор — 15 документов (ТЗ §12).
        eval: manifest.length < 15,
      })
    }
  }

  // Скан низкого качества: тот же инвойс, испорченный программно.
  const scanSource = invoice(900)
  const scanPdf = await renderPdf(scanSource.lines, 'classic')
  writeFileSync(join(outDir, 'scan-low-quality.jpg'), await degrade(scanPdf))
  manifest.push({
    file: 'scan-low-quality.jpg',
    expectedType: 'invoice',
    criticalFields: scanSource.critical,
    eval: false,
    note: 'Скан низкого качества: поворот, шум, снижение контраста, рукописная пометка',
  })

  // Дубликат уже обработанного документа: тот же файл побайтно.
  writeFileSync(join(outDir, 'duplicate-invoice.pdf'), firstInvoiceBytes)
  manifest.push({
    file: 'duplicate-invoice.pdf',
    expectedType: 'invoice',
    criticalFields: manifest.find((item) => item.file === firstInvoiceFile).criticalFields,
    eval: false,
    note: `Дубликат ${firstInvoiceFile} по checksum`,
  })

  // Повреждённый файл: сигнатура PDF есть, объектов нет.
  writeFileSync(
    join(outDir, 'corrupted.pdf'),
    Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('содержимое повреждено')]),
  )
  manifest.push({
    file: 'corrupted.pdf',
    expectedType: null,
    criticalFields: {},
    eval: false,
    note: 'Повреждённый файл: ожидается отклонение до вызова LLM',
  })

  // Несколько документов в одном файле: повторная шапка INVOICE.
  const multi = invoice(901)
  const multiPdf = await renderPdf([...multi.lines, { gap: 30 }, ...invoice(902).lines], 'compact')
  writeFileSync(join(outDir, 'multi-document.pdf'), multiPdf)
  manifest.push({
    file: 'multi-document.pdf',
    expectedType: 'invoice',
    criticalFields: multi.critical,
    eval: false,
    note: 'Два документа в одном файле: ожидается предупреждение',
  })

  writeFileSync(
    join(outDir, 'ground-truth.json'),
    `${JSON.stringify({ baseDate: formatDate(BASE_DATE, 'iso'), documents: manifest }, null, 2)}\n`,
  )

  const evalCount = manifest.filter((item) => item.eval).length
  console.log(`Сгенерировано документов: ${manifest.length}, из них размеченных: ${evalCount}`)
  console.log(`Каталог: ${outDir}`)
}

main().catch((error) => {
  console.error('Генерация не удалась:', error)
  process.exit(1)
})
