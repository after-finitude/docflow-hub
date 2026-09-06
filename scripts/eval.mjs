/**
 * Quality evaluation on the labeled dataset (spec §12). Report: evaluation/last-run.md.
 *
 * The harness runs the same OCR/LLM providers, field builder, evidence matcher,
 * validation engine, and routing as production. It excludes only the database
 * and queues, measuring processing logic rather than delivery infrastructure.
 *
 * OCR_PROVIDER and LLM_PROVIDER select providers exactly as in production.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const datasetDir = join(root, 'evaluation', 'dataset')

const shared = await import('@docflow/shared')
const core = await import('@docflow/core')
const { inspect } = await import('../apps/worker/dist/preprocess/document-inspector.js')
const { MockOcrProvider } = await import('../apps/worker/dist/ocr/mock-ocr.provider.js')
const { MockLlmProvider } = await import('../apps/worker/dist/llm/mock-llm.provider.js')

const { buildExtractedField, validateDocument, decideRouting } = shared
const { SEED_SCHEMAS, SEED_RULES, DEFAULT_THRESHOLDS } = core

const ocrName = process.env.OCR_PROVIDER ?? 'mock'
const llmName = process.env.LLM_PROVIDER ?? 'mock'

async function buildProviders() {
  if (ocrName === 'google' || llmName === 'openai_compatible') {
    // Real providers require credentials and load only when requested.
    const { GoogleVisionOcrProvider } =
      await import('../apps/worker/dist/ocr/google-vision-ocr.provider.js')
    const { OpenAiCompatibleLlmProvider } =
      await import('../apps/worker/dist/llm/openai-compatible-llm.provider.js')
    return {
      ocr:
        ocrName === 'google'
          ? new GoogleVisionOcrProvider({
              keyFile: required('GOOGLE_VISION_KEY_FILE'),
              renderDpi: Number(process.env.OCR_RENDER_DPI ?? 200),
              languageHints: (process.env.OCR_LANGUAGE_HINTS ?? 'ru,en').split(','),
            })
          : new MockOcrProvider(),
      llm:
        llmName === 'openai_compatible'
          ? new OpenAiCompatibleLlmProvider({
              baseUrl: required('LLM_BASE_URL'),
              apiKey: required('LLM_API_KEY'),
              model: required('LLM_MODEL'),
              timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120000),
            })
          : new MockLlmProvider(),
    }
  }
  return { ocr: new MockOcrProvider(), llm: new MockLlmProvider() }
}

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Selected providers require ${name}`)
  return value
}

/** Run one document through the production processing path. */
async function processDocument(providers, file, mimeType) {
  const buffer = readFileSync(join(datasetDir, file))

  const inspection = await inspect(buffer, mimeType)
  if (!inspection.ok) {
    return { rejected: true, rejectReason: inspection.code }
  }

  const ocr = await providers.ocr.recognize(buffer, mimeType)
  const pagesText = ocr.pages.map((page) => ({ page: page.pageNumber, text: page.text }))
  const evidencePages = ocr.pages.map((page) => ({
    pageNumber: page.pageNumber,
    blocks: page.blocks,
  }))

  const classification = await providers.llm.classify({ pagesText: pagesText.slice(0, 2) })
  const thresholds = DEFAULT_THRESHOLDS
  const resolvedType =
    classification.document_type && classification.confidence >= thresholds.autoClassify
      ? classification.document_type
      : 'unknown'

  if (resolvedType === 'unknown') {
    return {
      rejected: false,
      documentType: 'unknown',
      typeConfidence: classification.confidence,
      fields: [],
      issues: [],
      decision: { auto: false },
      multiDocument: classification.multi_document_suspected,
    }
  }

  const specs = SEED_SCHEMAS[resolvedType]
  const extraction = await providers.llm.extract({
    documentType: resolvedType,
    fields: specs,
    pagesText,
  })
  const byName = new Map(extraction.fields.map((field) => [field.name, field]))
  const fields = specs.map((spec) =>
    buildExtractedField(spec, byName.get(spec.name), evidencePages),
  )

  const validationFields = fields.map((field, index) => ({
    name: field.name,
    label: specs[index].label,
    valueType: field.valueType,
    rawValue: field.rawValue,
    normalizedValue: field.normalizedValue,
    isRequired: specs[index].required,
    isCritical: field.isCritical,
  }))
  const issues = validateDocument(validationFields, SEED_RULES[resolvedType], {
    today: new Date().toISOString().slice(0, 10),
  })

  // Suspected multiple documents force review (spec 6.3), matching ValidationRunnerService.
  const routingIssues = issues.map((issue) => ({ severity: issue.severity, resolved: false }))
  if (classification.multi_document_suspected) {
    routingIssues.push({ severity: 'warning', resolved: false, forcesReview: true })
  }

  const decision = decideRouting(
    validationFields.map((field, index) => ({
      name: field.name,
      label: field.label,
      isCritical: field.isCritical,
      confidence: fields[index].confidence,
      sourceFound: fields[index].sourceFound,
    })),
    routingIssues,
    thresholds,
  )

  return {
    rejected: false,
    documentType: resolvedType,
    typeConfidence: classification.confidence,
    specs,
    fields,
    issues,
    decision,
    multiDocument: classification.multi_document_suspected,
  }
}

/** Compare a normalized value with ground truth. */
function valuesMatch(actual, expected) {
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Math.abs(actual - expected) < 0.005
  }
  return String(actual ?? '') === String(expected)
}

function percent(part, total) {
  return total === 0 ? null : Math.round((part / total) * 1000) / 10
}

async function main() {
  const providers = await buildProviders()
  const groundTruth = JSON.parse(readFileSync(join(datasetDir, 'ground-truth.json'), 'utf8'))

  const counters = {
    processed: 0,
    classified: 0,
    classifiedCorrect: 0,
    criticalTotal: 0,
    criticalMatched: 0,
    requiredTotal: 0,
    requiredCovered: 0,
    extractedValues: 0,
    extractedWithSource: 0,
    autoApproved: 0,
    falseAutoApproval: 0,
    rejectedExpected: 0,
    rejectedActual: 0,
    multiDocumentDetected: 0,
  }
  const perDocument = []

  for (const entry of groundTruth.documents) {
    const mimeType = entry.file.endsWith('.jpg')
      ? 'image/jpeg'
      : entry.file.endsWith('.png')
        ? 'image/png'
        : 'application/pdf'

    const result = await processDocument(providers, entry.file, mimeType)
    const isEval = entry.eval === true

    if (entry.expectedType === null) {
      counters.rejectedExpected += 1
      if (result.rejected) counters.rejectedActual += 1
      perDocument.push({
        file: entry.file,
        outcome: result.rejected ? 'rejected' : 'ACCEPTED (error)',
      })
      continue
    }

    if (result.rejected) {
      perDocument.push({ file: entry.file, outcome: `rejected: ${result.rejectReason}` })
      continue
    }

    counters.processed += 1
    counters.classified += 1
    if (result.documentType === entry.expectedType) counters.classifiedCorrect += 1
    if (result.multiDocument) counters.multiDocumentDetected += 1

    // No extracted fields means there is nothing to compare, not a match.
    let documentCriticalOk = result.specs ? true : null
    if (result.specs) {
      for (const spec of result.specs) {
        const field = result.fields.find((item) => item.name === spec.name)
        if (spec.required) {
          counters.requiredTotal += 1
          if (field && field.rawValue !== null) counters.requiredCovered += 1
        }
        if (field && field.rawValue !== null) {
          counters.extractedValues += 1
          if (field.sourceFound) counters.extractedWithSource += 1
        }
      }

      for (const [name, expected] of Object.entries(entry.criticalFields ?? {})) {
        counters.criticalTotal += 1
        const field = result.fields.find((item) => item.name === name)
        if (field && valuesMatch(field.normalizedValue, expected)) {
          counters.criticalMatched += 1
        } else {
          documentCriticalOk = false
        }
      }
    }

    if (result.decision.auto) {
      counters.autoApproved += 1
      // Invalid document passed automatically (spec §12 target: zero).
      if (isEval && !documentCriticalOk) counters.falseAutoApproval += 1
    }

    perDocument.push({
      file: entry.file,
      outcome: result.decision.auto ? 'automatic' : 'review',
      type: result.documentType,
      criticalOk: documentCriticalOk,
    })
  }

  const metrics = [
    {
      name: 'Classification accuracy',
      value: percent(counters.classifiedCorrect, counters.classified),
      target: '≥ 95%',
      unit: '%',
    },
    {
      name: 'Critical field exact match',
      value: percent(counters.criticalMatched, counters.criticalTotal),
      target: '≥ 90%',
      unit: '%',
    },
    {
      name: 'Field coverage',
      value: percent(counters.requiredCovered, counters.requiredTotal),
      target: '≥ 98%',
      unit: '%',
    },
    {
      name: 'Source coverage',
      value: percent(counters.extractedWithSource, counters.extractedValues),
      target: 'reported as-is',
      unit: '%',
    },
    {
      name: 'Straight-through rate',
      value: percent(counters.autoApproved, counters.processed),
      target: 'reported as-is',
      unit: '%',
    },
    {
      name: 'False auto-approval',
      value: counters.falseAutoApproval,
      target: '0 on the labeled dataset',
      unit: '',
    },
  ]

  const failures = metrics.filter((metric) => {
    if (metric.name === 'False auto-approval') return metric.value > 0
    if (metric.target.startsWith('≥')) {
      const goal = Number(metric.target.replace(/[^\d.]/g, ''))
      return metric.value !== null && metric.value < goal
    }
    return false
  })

  const evalCount = groundTruth.documents.filter((item) => item.eval).length
  const report = [
    '# Quality Evaluation Report',
    '',
    `Run date: ${new Date().toISOString()}`,
    `Dataset: ${groundTruth.documents.length} documents, ${evalCount} labeled`,
    `Providers: OCR — \`${ocrName}\`, LLM — \`${llmName}\``,
    'Schema version: 1 (seed), rules: ' +
      Object.values(SEED_RULES).reduce((sum, rules) => sum + rules.length, 0),
    '',
    '## Metrics (spec §12)',
    '',
    '| Metric | Value | Target |',
    '| --- | --- | --- |',
    ...metrics.map(
      (metric) =>
        `| ${metric.name} | ${metric.value === null ? '—' : `${metric.value}${metric.unit}`} | ${metric.target} |`,
    ),
    `| Median review time | not measured here | requires operator telemetry |`,
    '',
    '## Negative scenarios',
    '',
    `- Corrupted files: rejected ${counters.rejectedActual} of ${counters.rejectedExpected}`,
    `- Multiple documents in one file: ${counters.multiDocumentDetected} warning(s)`,
    '',
    '## How to read this report',
    '',
    llmName === 'mock'
      ? [
          'This run used **mock providers**. The mock LLM knows the demo label format,',
          'so high extraction scores validate the evidence matcher, normalization,',
          'validation, and routing pipeline, NOT language-model quality. Measure the',
          'model with `LLM_PROVIDER=openai_compatible` and real credentials.',
        ].join(' ')
      : 'This run used real providers, so values reflect model quality.',
    '',
    '## Documents',
    '',
    '| File | Type | Outcome | Critical fields |',
    '| --- | --- | --- | --- |',
    ...perDocument.map(
      (item) =>
        `| ${item.file} | ${item.type ?? '—'} | ${item.outcome} | ${
          item.criticalOk === undefined || item.criticalOk === null
            ? '—'
            : item.criticalOk
              ? 'matched'
              : 'mismatch'
        } |`,
    ),
    '',
  ].join('\n')

  writeFileSync(join(root, 'evaluation', 'last-run.md'), report)

  for (const metric of metrics) {
    const value = metric.value === null ? '—' : `${metric.value}${metric.unit}`
    console.log(`${metric.name.padEnd(28)} ${String(value).padStart(8)}   target: ${metric.target}`)
  }
  console.log(`\nReport: evaluation/last-run.md`)

  if (failures.length > 0) {
    console.error(`\nTargets not met: ${failures.map((item) => item.name).join(', ')}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Evaluation failed:', error)
  process.exit(1)
})
