import 'reflect-metadata'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  DEFAULT_THRESHOLDS,
  SEED_SCHEMAS,
  SEED_RULES,
  documents,
  documentSchemas,
  fields,
  pages,
  workflowRuns,
  auditEvents,
  validationIssues,
  ValidationRunnerService,
} from '@docflow/core'
import { buildCanonicalDocument, buildExtractedField } from '@docflow/shared'
import { MockLlmProvider } from '../apps/worker/dist/llm/mock-llm.provider.js'
import { OpenAiCompatibleLlmProvider } from '../apps/worker/dist/llm/openai-compatible-llm.provider.js'
import { LlmInvalidResponseError } from '../apps/worker/dist/llm/llm-provider.js'
import { ExtractProcessor } from '../apps/worker/dist/extract/extract.processor.js'
import { MockOcrProvider } from '../apps/worker/dist/ocr/mock-ocr.provider.js'

const input = { documentType: 'invoice', fields: SEED_SCHEMAS.invoice, pagesText: [] }
const missingResponse = {
  fields: input.fields.map(({ name }) => ({ name, value: null, evidence: null })),
}
const invalidResponse = { fields: [] }

function realProvider(t, replies) {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body))
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]
    return Response.json({
      choices: [
        { message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } },
      ],
    })
  })
  const provider = new OpenAiCompatibleLlmProvider({
    baseUrl: 'https://llm.invalid',
    apiKey: 'test',
    model: 'test',
    timeoutMs: 1000,
  })
  return { provider, requests }
}

test('real provider repairs malformed JSON and selected-schema failures within two repairs', async (t) => {
  const { provider, requests } = realProvider(t, ['not json', invalidResponse, missingResponse])
  assert.deepEqual(await provider.extract(input), missingResponse)
  assert.equal(requests.length, 3)
  assert.match(requests[1].messages.at(-1).content, /not valid JSON/)
  assert.match(requests[2].messages.at(-1).content, /failed validation/)
})

test('real provider accepts line-item arrays without a repair', async (t) => {
  const response = structuredClone(missingResponse)
  response.fields.at(-1).value = [
    { description: 'Service', quantity: 2, unit_price: 10, amount: 20 },
  ]
  const { provider, requests } = realProvider(t, [response])
  assert.deepEqual(await provider.extract(input), response)
  assert.equal(requests.length, 1)
})

test('real provider exhausts exactly two repairs for schema-invalid responses', async (t) => {
  const { provider, requests } = realProvider(t, [invalidResponse])
  await assert.rejects(provider.extract(input), LlmInvalidResponseError)
  assert.equal(requests.length, 3)
})

test('mock fixture items survive OCR, extraction, source matching, and canonical export', async () => {
  const ocr = new MockOcrProvider()
  const llm = new MockLlmProvider()
  for (const [file, hasItems] of [
    ['../evaluation/dataset/invoice-001.pdf', true],
    ['./fixtures/sample-invoice.pdf', false],
  ]) {
    const result = await ocr.recognize(
      await readFile(new URL(file, import.meta.url)),
      'application/pdf',
    )
    const response = await llm.extract({
      ...input,
      pagesText: result.pages.map((p) => ({ page: p.pageNumber, text: p.text })),
    })
    const byName = new Map(response.fields.map((f) => [f.name, f]))
    const rows = input.fields.map((spec) => ({
      ...buildExtractedField(spec, byName.get(spec.name), result.pages),
      isEdited: false,
    }))
    const canonical = buildCanonicalDocument({
      documentId: 'doc',
      documentType: 'invoice',
      schemaVersion: 1,
      sourceType: 'upload',
      originalFilename: file,
      checksum: 'test',
      receivedAt: '2026-09-06',
      approvedAt: null,
      generatedAt: '2026-09-06',
      warnings: [],
      fields: rows,
    })
    const items = rows.find((f) => f.name === 'line_items')
    if (hasItems) {
      assert.ok(canonical.lineItems.length > 0)
      assert.deepEqual(canonical.lineItems, byName.get('line_items').value)
      assert.equal(items.sourceFound, true)
      assert.ok(
        canonical.lineItems.every((item) => item.amount === null),
        'Unprinted amounts must not be inferred',
      )
    } else {
      assert.equal(canonical.lineItems, null)
      assert.equal(items.rawValue, null)
      assert.equal(items.sourceFound, false)
    }
  }
})

test('mock collects rows across pages and only uses printed numeric cells', async () => {
  const response = await new MockLlmProvider().extract({
    ...input,
    pagesText: [
      { page: 1, text: 'Service x2 10.00 20.00' },
      { page: 2, text: 'Position 2  x3  15.00\nSubtotal: 35.00' },
    ],
  })
  assert.deepEqual(response.fields.at(-1).value, [
    { description: 'Service', quantity: 2, unit_price: 10, amount: 20 },
    { description: 'Position 2', quantity: 3, unit_price: 15, amount: null },
  ])
})

function pending(run) {
  const query = Promise.resolve().then(run)
  query.returning = () => query
  query.onConflictDoNothing = () => {
    query.ignoreConflict = true
    return query
  }
  return query
}

// A single-document Drizzle test double exercises processor ordering and rollback.
// PostgreSQL isolation/concurrency still needs the separate Compose acceptance run.
function database(previous = []) {
  let tables = new Map([
    [
      documents,
      [{ id: 'doc', documentType: 'invoice', status: 'processing', storageKey: 'original' }],
    ],
    [
      documentSchemas,
      [
        {
          id: 'schema',
          documentType: 'invoice',
          version: 1,
          jsonSchema: { fields: input.fields, rules: SEED_RULES.invoice },
          thresholds: DEFAULT_THRESHOLDS,
        },
      ],
    ],
    [pages, [{ page: 1, text: 'Original OCR', blocks: [] }]],
    [fields, structuredClone(previous)],
    [workflowRuns, []],
    [auditEvents, [{ action: 'field.edited', objectId: previous[0]?.id }]],
    [validationIssues, []],
  ])
  const rows = (table) => tables.get(table) ?? []
  const db = {
    failInsert: false,
    failValidation: false,
    transactions: 0,
    rows,
    select(selection) {
      return {
        from(table) {
          const query = pending(() => {
            // External-issue lookup must not return engine-generated issues.
            if (table === validationIssues && selection) return []
            return rows(table)
          })
          query.where = query.limit = query.orderBy = () => query
          return query
        },
      }
    },
    insert(table) {
      return {
        values(values) {
          const query = pending(() => {
            if (table === fields && db.failInsert) throw new Error('injected insert failure')
            if (table === validationIssues && db.failValidation)
              throw new Error('injected validation failure')
            const inserted = (Array.isArray(values) ? values : [values]).map((value, i) => ({
              id: `row-${i}`,
              ...value,
            }))
            tables.set(table, [
              ...rows(table),
              ...inserted.filter(
                (row) =>
                  !query.ignoreConflict ||
                  !rows(table).some((existing) => existing.name === row.name),
              ),
            ])
            return inserted
          })
          return query
        },
      }
    },
    update(table) {
      return {
        set(value) {
          return {
            where: async () => {
              rows(table).forEach((row) => Object.assign(row, value))
            },
          }
        },
      }
    },
    delete(table) {
      return {
        where: async () => {
          tables.set(table, [])
        },
      }
    },
    async transaction(fn) {
      db.transactions++
      const snapshot = new Map(
        [...tables].map(([table, values]) => [table, structuredClone(values)]),
      )
      try {
        return await fn(db)
      } catch (error) {
        tables = snapshot
        throw error
      }
    },
  }
  return db
}

function worker(db, llm) {
  const events = []
  const jobs = []
  const processor = new ExtractProcessor(
    db,
    {},
    llm,
    {
      async publish(event) {
        if (event.status === 'needs_review' && !db.rows(fields).some((f) => f.rawValue !== null)) {
          assert.ok(db.rows(validationIssues).some((issue) => issue.severity === 'blocking'))
        }
        events.push(event)
      },
    },
    {
      async add(...args) {
        jobs.push(args)
      },
    },
    new ValidationRunnerService(db, {}),
  )
  return { processor, events, jobs }
}
const job = {
  data: { documentId: 'doc', correlationId: 'correlation' },
  opts: { attempts: 3 },
  attemptsMade: 0,
}
const previous = [
  {
    ...buildExtractedField(input.fields[0], { value: 'Previous supplier', evidence: null }, []),
    id: 'previous-field',
    documentId: 'doc',
    isEdited: true,
  },
]

test('repair exhaustion creates all Missing fields and blocking issues before manual review', async (t) => {
  const db = database()
  const original = structuredClone(db.rows(pages))
  const { provider, requests } = realProvider(t, [invalidResponse])
  const { processor, events, jobs } = worker(db, provider)
  await processor.process(job)
  assert.equal(requests.length, 3)
  assert.equal(db.rows(fields).length, input.fields.length)
  assert.ok(
    db
      .rows(fields)
      .every((f) => f.rawValue === null && f.normalizedValue === null && !f.sourceFound),
  )
  assert.equal(db.rows(documents)[0].status, 'needs_review')
  assert.equal(db.rows(workflowRuns)[0].errorCode, 'llm_invalid_response')
  assert.deepEqual(db.rows(pages), original)
  assert.equal(db.rows(documents)[0].storageKey, 'original')
  assert.equal(events.at(-1).status, 'needs_review')
  assert.equal(jobs.length, 0)
})

test('failed re-extraction retains previous values, field IDs, edits, and audit history', async (t) => {
  const db = database(previous)
  const audit = structuredClone(db.rows(auditEvents))
  const { provider } = realProvider(t, [invalidResponse])
  await worker(db, provider).processor.process(job)
  assert.deepEqual(
    db.rows(fields).find((f) => f.id === 'previous-field'),
    previous[0],
  )
  assert.deepEqual(db.rows(auditEvents).slice(0, audit.length), audit)
})

test('replacement insert failure rolls back previous fields and leaves audit history intact', async () => {
  const db = database(previous)
  db.failInsert = true
  const audit = structuredClone(db.rows(auditEvents))
  const { processor, jobs } = worker(db, new MockLlmProvider())
  await assert.rejects(processor.process(job), /injected insert failure/)
  assert.equal(db.transactions, 1)
  assert.deepEqual(db.rows(fields), previous)
  assert.deepEqual(db.rows(auditEvents), audit)
  assert.equal(jobs.length, 0)
})

test('successful extraction commits a complete field set and queues validation', async () => {
  const db = database(previous)
  const { processor, jobs } = worker(db, new MockLlmProvider())
  await processor.process(job)
  assert.equal(db.transactions, 1)
  assert.equal(db.rows(fields).length, input.fields.length)
  assert.equal(
    db.rows(fields).some((f) => f.id === 'previous-field'),
    false,
  )
  assert.equal(jobs.length, 1)
  assert.equal(db.rows(workflowRuns)[0].state, 'succeeded')
})

test('recovery validation failure never exposes an unvalidated manual form', async (t) => {
  const db = database()
  db.failValidation = true
  const { provider } = realProvider(t, [invalidResponse])
  const { processor, events } = worker(db, provider)
  await assert.rejects(processor.process(job), /injected validation failure/)
  assert.equal(db.rows(documents)[0].status, 'processing')
  assert.equal(
    events.some((event) => event.status === 'needs_review'),
    false,
  )
})
