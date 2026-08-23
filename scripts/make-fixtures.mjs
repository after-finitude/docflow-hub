// Generate fixtures for verify.sh and offline checks. Each line in the minimal
// PDF is a separate OCR text block.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function buildPdf(lines) {
  const streamParts = lines.map(
    (line, index) =>
      `BT /F1 14 Tf 60 ${780 - index * 24} Td (${line.replace(/([()\\])/g, '\\$1')}) Tj ET`,
  )
  const stream = streamParts.join('\n')

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

// “Label: value” is the mock LLM provider contract.
writeFileSync(
  join(out, 'sample-invoice.pdf'),
  buildPdf([
    'INVOICE',
    'Supplier: Acme GmbH',
    'Invoice No: DF-1001',
    'Date: 15.07.2026',
    'Due Date: 14.08.2026',
    'Currency: EUR',
    'Subtotal: 1200.00',
    'Tax: 240.00',
    'Total: 1440.00',
  ]),
)

// The same invoice with mismatched totals: 1200 + 240 ≠ 1400 (criterion 6).
writeFileSync(
  join(out, 'invoice-sum-mismatch.pdf'),
  buildPdf([
    'INVOICE',
    'Supplier: Globex Ltd',
    'Invoice No: DF-2002',
    'Date: 16.07.2026',
    'Due Date: 15.08.2026',
    'Currency: EUR',
    'Subtotal: 1200.00',
    'Tax: 240.00',
    'Total: 1400.00',
  ]),
)

writeFileSync(
  join(out, 'corrupted.pdf'),
  Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('broken content without objects')]),
)

console.log('Fixtures written to', out)
