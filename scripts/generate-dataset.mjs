/**
 * Demo dataset generator (spec §13).
 *
 * Documents are synthetic and contain no real personal data. Ground truth comes
 * from generator inputs, and a fixed seed keeps reruns deterministic.
 *
 * Plan deviation: pdf-lib draws PDFs directly because Playwright would download
 * Chromium (~150 MB) and require external network access.
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

/** Deterministic RNG keeps the corpus and ground truth aligned across runs. */
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
  'Megabuild LLC',
  'Vector LLC',
  'Soylent Corp',
  'Hooli Inc',
]
const BANKS = ['Nordbank AG', 'Alpha Banking', 'First Bank PLC', 'Meridian Trust']
const AUTHORITIES = ['Federal Tax Office', 'City Revenue Service', 'HM Revenue & Customs']
const SUBJECTS = ['Tax base clarification', 'Request for clarification', 'Payment reminder']
const CONTRACT_SUBJECTS = [
  'Software development services',
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

/** Fixed date baseline prevents ground truth from expiring over time. */
const BASE_DATE = new Date(Date.UTC(2026, 5, 1))

async function renderPdf(lines, layout) {
  const pdf = await PDFDocument.create()
  pdf.setCreationDate(BASE_DATE)
  pdf.setModificationDate(BASE_DATE)
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

/** Invoice with three layout variants and varied values and currencies (spec §13). */
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
    extra: {
      due_date: formatDate(due, 'iso'),
      tax_total: tax,
      line_items: items.map((item) => ({ ...item, amount: null })),
    },
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
    extra: { currency },
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
  const taxpayerId = String(between(1000000000, 9999999999))
  const subject = pick(SUBJECTS)

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
      { text: `Taxpayer ID: ${taxpayerId}` },
      { text: `Subject: ${subject}` },
      { rule: true },
      { text: `Amount Due: ${amount.toFixed(2)}` },
      { text: `Pay By: ${formatDate(addDays(date, 30), 'eu')}` },
    ],
    extra: {
      taxpayer_id: taxpayerId,
      subject,
      amount_due: amount,
      due_date: formatDate(addDays(date, 30), 'iso'),
    },
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
  const subject = pick(CONTRACT_SUBJECTS)
  const currency = pick(CURRENCIES)

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
      { text: `Subject: ${subject}` },
      { text: `Value: ${value.toFixed(2)}` },
      { text: `Currency: ${currency}` },
      { text: `Valid From: ${formatDate(date, 'eu')}` },
      { text: `Valid To: ${formatDate(addDays(date, 365), 'eu')}` },
    ],
    extra: {
      subject,
      contract_value: value,
      currency,
      start_date: formatDate(date, 'iso'),
      end_date: formatDate(addDays(date, 365), 'iso'),
    },
    critical: {
      contract_number: number,
      contract_date: formatDate(date, 'iso'),
      party_a: partyA,
      party_b: partyB,
    },
  }
}

/** Poor scan with rotation, noise, and reduced contrast (spec §13). */
async function degrade(pdfBuffer) {
  const { openPdf, renderPdfPage } = await import('../packages/core/dist/pdf.js')
  const document = await openPdf(pdfBuffer)
  let png
  try {
    png = (await renderPdfPage(await document.getPage(1), 1.6)).png
  } finally {
    await document.loadingTask.destroy()
  }

  const meta = await sharp(png).metadata()
  const noise = Buffer.alloc((meta.width ?? 1) * (meta.height ?? 1))
  for (let i = 0; i < noise.length; i++) noise[i] = 110 + Math.floor(random() * 36)

  return sharp(png)
    .rotate(2.5, { background: '#ffffff' })
    .linear(0.72, 30) // Reduce contrast.
    .composite([
      {
        input: noise,
        raw: { width: meta.width ?? 1, height: meta.height ?? 1, channels: 1 },
        blend: 'overlay',
        tile: true,
      },
      // Handwritten-style margin note.
      {
        input: Buffer.from(
          `<svg width="${meta.width}" height="${meta.height}"><text x="${(meta.width ?? 0) * 0.62}" y="${(meta.height ?? 0) * 0.18}" font-family="cursive" font-size="34" fill="#2b4fa2" transform="rotate(-7 ${(meta.width ?? 0) * 0.62} ${(meta.height ?? 0) * 0.18})">paid</text></svg>`,
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
        expectedFields: { ...spec.critical, ...spec.extra },
        expectedAutoAllowed: true,
        // The labeled evaluation set contains 15 documents (spec §12).
        eval: index < (type === 'invoice' ? 2 : 3),
      })
    }
  }

  // Poor scan: the same invoice degraded programmatically.
  const scanSource = invoice(900)
  const scanPdf = await renderPdf(scanSource.lines, 'classic')
  writeFileSync(join(outDir, 'scan-low-quality.jpg'), await degrade(scanPdf))
  manifest.push({
    file: 'scan-low-quality.jpg',
    expectedType: 'invoice',
    criticalFields: scanSource.critical,
    expectedFields: { ...scanSource.critical, ...scanSource.extra },
    expectedAutoAllowed: false,
    eval: false,
    note: 'Poor scan: rotation, noise, reduced contrast, and handwritten note',
  })

  // Byte-for-byte duplicate of an existing document.
  writeFileSync(join(outDir, 'duplicate-invoice.pdf'), firstInvoiceBytes)
  manifest.push({
    file: 'duplicate-invoice.pdf',
    expectedType: 'invoice',
    criticalFields: manifest.find((item) => item.file === firstInvoiceFile).criticalFields,
    expectedFields: manifest.find((item) => item.file === firstInvoiceFile).expectedFields,
    expectedAutoAllowed: false,
    eval: false,
    note: `Checksum duplicate of ${firstInvoiceFile}`,
  })

  // Corrupted file with a PDF signature but no objects.
  writeFileSync(
    join(outDir, 'corrupted.pdf'),
    Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('corrupted content')]),
  )
  manifest.push({
    file: 'corrupted.pdf',
    expectedType: null,
    criticalFields: {},
    expectedFields: {},
    expectedAutoAllowed: false,
    eval: true,
    note: 'Corrupted file expected to be rejected before an LLM call',
  })

  // Multiple documents in one file indicated by a repeated INVOICE heading.
  const multi = invoice(901)
  const multiPdf = await renderPdf([...multi.lines, { gap: 30 }, ...invoice(902).lines], 'compact')
  writeFileSync(join(outDir, 'multi-document.pdf'), multiPdf)
  manifest.push({
    file: 'multi-document.pdf',
    expectedType: 'invoice',
    criticalFields: multi.critical,
    expectedFields: { ...multi.critical, ...multi.extra },
    expectedAutoAllowed: false,
    multiDocument: true,
    eval: true,
    note: 'Two documents in one file; warning expected',
  })

  for (const scenario of ['missing-critical', 'sum-mismatch', 'optional-missing']) {
    const spec = invoice(910 + manifest.length)
    const expectedFields = { ...spec.critical, ...spec.extra }
    if (scenario === 'missing-critical') {
      spec.lines = spec.lines.filter((line) => !line.text?.startsWith('Supplier:'))
      expectedFields.supplier_name = null
      spec.critical.supplier_name = null
    } else if (scenario === 'sum-mismatch') {
      expectedFields.grand_total += 10
      spec.critical.grand_total += 10
      spec.lines = spec.lines.map((line) =>
        line.text?.startsWith('Total:')
          ? { ...line, text: `Total: ${expectedFields.grand_total.toFixed(2)}` }
          : line,
      )
    } else {
      spec.lines = spec.lines.filter((line) => !line.text?.startsWith('Due Date:'))
      expectedFields.due_date = null
    }
    const file = `${scenario}.pdf`
    writeFileSync(join(outDir, file), await renderPdf(spec.lines, spec.layout))
    manifest.push({
      file,
      expectedType: 'invoice',
      criticalFields: spec.critical,
      expectedFields,
      expectedAutoAllowed: scenario === 'optional-missing',
      eval: scenario !== 'optional-missing',
      note: scenario,
    })
  }

  writeFileSync(
    join(outDir, 'ground-truth.json'),
    `${JSON.stringify({ version: 2, labelSource: 'synthetic generator inputs; null means visibly absent', baseDate: formatDate(BASE_DATE, 'iso'), documents: manifest }, null, 2)}\n`,
  )

  const evalCount = manifest.filter((item) => item.eval).length
  console.log(`Generated ${manifest.length} documents, ${evalCount} labeled`)
  console.log(`Directory: ${outDir}`)
}

main().catch((error) => {
  console.error('Generation failed:', error)
  process.exit(1)
})
