import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { evaluationClient } from './eval-client.mjs'
import { score } from './eval-metrics.mjs'

const dataset = 'evaluation/dataset'
const client = await evaluationClient()
if ((await client.json('/documents?pageSize=1')).total !== 0)
  throw new Error(
    'Quality evaluation requires an empty disposable stack; existing documents would change duplicate/uniqueness decisions',
  )
const manifestBytes = await readFile(join(dataset, 'ground-truth.json'))
const manifest = JSON.parse(manifestBytes)
if (
  manifest.version !== 3 ||
  manifest.documents.filter((doc) => doc.eval).length !== 15 ||
  manifest.documents.some(
    (doc) => !doc.expectedFields || typeof doc.expectedAutoAllowed !== 'boolean',
  )
)
  throw new Error(
    'Regenerate the version 3 dataset: statement transactions, exactly 15 labeled documents and complete expected values are required',
  )
const runtime = await client.json('/documents/review-metrics')
const schemas = await client.json('/schemas')
const startedAt = new Date().toISOString(),
  results = []
for (const entry of manifest.documents) {
  let result
  try {
    result = await client.settle(await client.upload(join(dataset, entry.file)))
  } catch (error) {
    result = { status: 'failed', error: error.message }
  }
  results.push({ file: entry.file, ...result })
  console.log(`${entry.file}: ${result.status}`)
}
const finalSchemas = await client.json('/schemas')
if (schemas.some((schema) => !finalSchemas.some((final) => final.id === schema.id)))
  throw new Error('Schema configuration changed during evaluation; rerun on an isolated stack')
const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  datasetVersion: manifest.version,
  datasetSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  providers: runtime.providers,
  concurrency: runtime.concurrency,
  schemas,
  validationDate: startedAt.slice(0, 10),
  labeled: score(
    manifest.documents.filter((doc) => doc.eval),
    results,
  ),
  corpus: score(manifest.documents, results),
  results,
  review: (await client.json(`/documents/review-metrics?since=${encodeURIComponent(startedAt)}`))
    .review,
}
const mock = runtime.providers.ocr === 'mock' || runtime.providers.llm === 'mock'
const lines = [
  '# Quality Evaluation Report',
  '',
  `Run: ${startedAt}`,
  `Dataset v${manifest.version}: ${manifest.documents.length} synthetic documents; 15 labeled across all four types and negative cases.`,
  `Manifest SHA-256: \`${report.datasetSha256}\``,
  `OCR: \`${runtime.providers.ocr}\` (model: \`${runtime.providers.ocrModel ?? 'native/default'}\`); LLM: \`${runtime.providers.llm}\`; model: \`${runtime.providers.model ?? 'deterministic mock'}\`.`,
  `Validation date: ${report.validationDate}. Rules and thresholds are those stored in each schema version.`,
  '',
  'The run uploads files through the real authenticated API and waits for production workers, PostgreSQL, Redis and object storage. No validation/confidence/routing code is reimplemented in the evaluator.',
  '',
  mock
    ? '**Mock run: pipeline evidence only. Real-provider quality remains unverified.**'
    : 'Both configured providers are real; scores apply only to this synthetic dataset.',
  '',
  '## Schema and rule versions',
  '',
  ...schemas.map(
    (s) =>
      `- ${s.documentType}: version ${s.version}, ID \`${s.id}\`, ${s.rules.length} rules; thresholds ${JSON.stringify(s.thresholds)}.`,
  ),
]
for (const [name, group] of [
  ['Labeled set (15 documents)', report.labeled],
  ['Full corpus', report.corpus],
]) {
  lines.push(
    '',
    `## ${name}`,
    '',
    '| Metric | Numerator / denominator | Value | Target | Result |',
    '| --- | --- | --- | --- | --- |',
    ...group.metrics.map(
      (m) =>
        `| ${m.name} | ${m.numerator} / ${m.denominator} | ${m.percent ?? 'N/A'}% | ${m.target === null ? 'reported' : `≥${m.target}%`} | ${m.meetsTarget === null ? '—' : m.meetsTarget ? 'met' : 'NOT MET'} |`,
    ),
    `| False auto-approval | ${group.counts.falseAutoApproval} / ${group.counts.autoApproved} auto-approved | ${group.counts.falseAutoApproval} | 0 | ${group.counts.falseAutoApproval === 0 ? 'met' : 'NOT MET'} |`,
    '',
    `Valid documents rejected: ${group.counts.rejectedValid}; failed/timeouts: ${group.counts.failed}; Unknown: ${group.counts.unknown}. Invalid files rejected: ${group.counts.rejectedInvalid}/${group.counts.invalid}. Multi-document warnings detected: ${group.counts.multiDetected}/${group.counts.multiExpected}.`,
  )
}
lines.push(
  '',
  '## Definitions and limitations',
  '',
  '- Classification and critical/field denominators come from the expected valid documents, including rejected, failed and Unknown results. A zero denominator is N/A and cannot satisfy a target.',
  '- Field coverage requires an actual field with a value when the source contains one, or an explicit null when ground truth says Missing. It does not measure value accuracy. Critical exact match compares normalized values (numeric tolerance below half a cent).',
  '- False auto-approval means Approved despite a prohibited automatic decision, wrong type, missing/wrong annotated value, or blocking issues. This includes corrupted, multi-document, required-Missing and invalid-sum cases, not just critical-value mismatches.',
  '- Straight-through rate uses all submitted documents. Source coverage uses all returned non-null values.',
  '- Ground truth comes from generator inputs, including optional Missing; it is not copied from OCR/LLM predictions. The synthetic corpus does not establish production document diversity.',
  `- Median human review time: ${report.review.medianMs ?? 'not measured'} ms; measured ${report.review.measured}/${report.review.approvals} manual approvals. This unattended run performs no human reviews.`,
  '- Processing latency, 20-document load and browser first-page/fields display are measured separately in performance reports. Polling adds up to 100 ms plus request time to observed completion.',
  '',
  '## Documents',
  '',
  '| File | Type | Outcome | Values match | Schema version | False auto |',
  '| --- | --- | --- | --- | --- | --- |',
  ...report.corpus.documents.map(
    (d) =>
      `| ${d.file} | ${d.type ?? '—'} | ${d.status} | ${d.correct} | ${d.schemaVersion ?? '—'} | ${d.falseAuto} |`,
  ),
  '',
)
await writeFile('evaluation/last-run.json', JSON.stringify(report, null, 2) + '\n')
await writeFile('evaluation/last-run.md', lines.join('\n'))
console.log(
  `Labeled targets: ${report.labeled.targetsMet ? 'met' : 'NOT MET'}; corpus: ${report.corpus.targetsMet ? 'met' : 'NOT MET'}`,
)
if (!report.labeled.targetsMet || !report.corpus.targetsMet) process.exitCode = 1
