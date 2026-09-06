import 'reflect-metadata'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { MockOcrProvider } from '../apps/worker/dist/ocr/mock-ocr.provider.js'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import {
  ENV,
  DEFAULT_THRESHOLDS,
  documents,
  documentSchemas,
  fields,
  pages,
  users,
  workflowRuns,
  documentExports,
  ValidationRunnerService,
} from '@docflow/core'
import { DocumentsController } from '../apps/api/dist/documents/documents.controller.js'
import { DocumentsService } from '../apps/api/dist/documents/documents.service.js'
import { PageRenderService } from '../apps/api/dist/documents/page-render.service.js'
import { ExportService } from '../apps/api/dist/export/export.service.js'
import { RunsController } from '../apps/api/dist/runs/runs.controller.js'
import { RunsService } from '../apps/api/dist/runs/runs.service.js'
import { ExtractProcessor } from '../apps/worker/dist/extract/extract.processor.js'
import { OcrProcessor } from '../apps/worker/dist/ocr/ocr.processor.js'
import { ClassifyProcessor } from '../apps/worker/dist/classify/classify.processor.js'
import { PreprocessProcessor } from '../apps/worker/dist/preprocess/preprocess.processor.js'
import { ValidateProcessor } from '../apps/worker/dist/validate/validate.processor.js'
import { LlmInvalidResponseError } from '../apps/worker/dist/llm/llm-provider.js'

// This URL must grant CREATE DATABASE. Only a fresh, randomly named database is
// migrated and dropped; the supplied database and its document data are untouched.
const adminUrl = process.env.TEST_DATABASE_URL
const deferred = () => Promise.withResolvers()
const specs = [
  { name: 'name', label: 'Name', type: 'string', required: true, critical: true },
  { name: 'total', label: 'Total', type: 'number', required: true, critical: false },
]
const rules = [
  { id: 'positive', field: 'total', type: 'number_range', min: 0, severity: 'blocking' },
]

test(
  'API validation and concurrent decisions on PostgreSQL',
  { skip: !adminUrl, timeout: 60000 },
  async (t) => {
    const admin = new Pool({ connectionString: adminUrl })
    const databaseName = `docflow_test_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    const url = new URL(adminUrl)
    url.pathname = `/${databaseName}`
    const pool = new Pool({ connectionString: url.href, max: 10 })
    t.after(async () => {
      await pool.end()
      await admin.query(`DROP DATABASE "${databaseName}"`)
      await admin.end()
    })
    await admin.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docflow_app') THEN CREATE ROLE docflow_app; END IF; END $$",
    )
    const db = drizzle(pool)
    await migrate(db, { migrationsFolder: 'packages/core/drizzle' })
    const [user] = await db
      .insert(users)
      .values({ login: 'operator', passwordHash: 'test', role: 'operator' })
      .returning()
    const [schema] = await db
      .insert(documentSchemas)
      .values({
        documentType: 'contract',
        version: 1,
        isActive: true,
        jsonSchema: { fields: specs, rules },
        thresholds: { ...DEFAULT_THRESHOLDS, criticalFieldConfidence: 0.1 },
      })
      .returning()
    const events = { async publish() {} }
    const jobs = []
    const queue = {
      async add(name, data) {
        jobs.push({ name, data })
      },
    }
    const validation = new ValidationRunnerService(db, {})
    const payloads = []
    let send = async (payload) => {
      payloads.push(payload)
      return 'exports/test.json'
    }
    const exports = new ExportService(
      db,
      [{ destination: 'file_json', send: (...args) => send(...args) }],
      events,
      {},
      validation,
    )
    const service = new DocumentsService(db, {}, events, validation, {}, exports, queue, queue)
    const runs = new RunsService(db, events, queue, queue, queue, queue, queue, validation)
    // eslint-disable-next-line typescript/no-extraneous-class -- Nest module metadata.
    class TestModule {}
    Module({
      controllers: [DocumentsController, RunsController],
      providers: [
        { provide: DocumentsService, useValue: service },
        { provide: RunsService, useValue: runs },
        { provide: PageRenderService, useValue: {} },
        { provide: ExportService, useValue: exports },
        { provide: ENV, useValue: {} },
      ],
    })(TestModule)
    const app = await NestFactory.create(TestModule, { logger: false })
    app.use((req, _res, next) => {
      req.user = user
      next()
    })
    await app.listen(0, '127.0.0.1')
    t.after(() => app.close())
    const base = await app.getUrl()
    async function request(id, action = '', body, method = 'POST') {
      const response = await fetch(`${base}/documents/${id}${action ? '/' + action : ''}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() }
    }
    async function runRequest(id, action) {
      const response = await fetch(`${base}/runs/${id}/${action}`, { method: 'POST' })
      return { status: response.status, body: await response.json() }
    }
    async function doc(
      status = 'needs_review',
      values = { name: 'Original', total: 10 },
      step = null,
    ) {
      const [row] = await db
        .insert(documents)
        .values({
          tenantId: randomUUID(),
          sourceType: 'upload',
          originalFilename: 'test.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1,
          checksum: randomUUID(),
          storageKey: 'test',
          documentType: 'contract',
          status,
          processingStep: step,
        })
        .returning()
      for (const spec of specs) {
        if (!(spec.name in values)) continue
        const value = values[spec.name]
        await db.insert(fields).values({
          documentId: row.id,
          schemaVersionId: schema.id,
          name: spec.name,
          valueType: spec.type,
          rawValue: value === null ? null : String(value),
          normalizedValue: value,
          sourceFound: true,
          sourcePage: 1,
          sourceBbox: { x: 0, y: 0, width: 0.1, height: 0.1 },
          confidence: 0.95,
        })
      }
      return row.id
    }
    const read = async (id) => (await request(id, '', undefined, 'GET')).body
    const row = async (id) => (await db.select().from(documents).where(eq(documents.id, id)))[0]

    await t.test(
      'empty extraction cannot approve; Missing fields and blocking issues persist',
      async () => {
        const id = await doc('needs_review', {})
        assert.equal((await request(id, 'approve')).status, 409)
        const detail = await read(id)
        assert.equal(detail.fields.length, 2)
        assert.equal(detail.canApprove, false)
        assert.equal(detail.issues.filter((i) => i.severity === 'blocking').length, 2)
        const edited = await request(id, 'fields/name', { value: 'Filled' }, 'PATCH')
        assert.equal(edited.status, 200)
        assert.equal(edited.body.canApprove, false, 'noncritical required total still blocks')
        assert.equal(
          (await request(id, 'fields/total', { value: '10' }, 'PATCH')).body.canApprove,
          true,
        )
        assert.equal((await request(id, 'approve')).status, 201)
      },
    )
    await t.test(
      'edit clears unsupported source, caps confidence, revalidates and permits manual approval',
      async () => {
        const id = await doc('approved')
        const edited = await request(id, 'fields/name', { value: 'Changed' }, 'PATCH')
        assert.equal(edited.status, 200)
        const field = edited.body.fields.find((f) => f.name === 'name')
        assert.equal(field.isEdited, true)
        assert.equal(field.sourceFound, false)
        assert.equal(field.sourceBbox, null)
        assert.equal(field.sourcePage, null)
        assert.ok(field.confidence <= 0.6)
        assert.equal(edited.body.status, 'needs_review')
        assert.equal(
          (await validation.run(id)).status,
          'needs_review',
          'low threshold must not auto-approve an unsourced critical value',
        )
        assert.equal(
          (await request(id, 'fields/total', { value: '-1' }, 'PATCH')).body.canApprove,
          false,
        )
        assert.equal((await request(id, 'approve')).status, 409)
        assert.equal(
          (await request(id, 'fields/total', { value: 'nonsense' }, 'PATCH')).body.canApprove,
          false,
        )
        assert.equal(
          (await request(id, 'fields/total', { value: '20' }, 'PATCH')).body.canApprove,
          true,
        )
        assert.equal((await request(id, 'approve')).status, 201)
        assert.equal((await request(id, 'export', {})).status, 201)
      },
    )
    await t.test('export revalidates actual fields even without cached issues', async () => {
      const id = await doc('approved', { name: 'Original', total: -5 })
      const before = payloads.length
      assert.equal((await request(id, 'export', {})).status, 409)
      assert.equal(payloads.length, before)
      assert.equal((await read(id)).status, 'needs_review')
      const empty = await doc('approved', {})
      assert.equal((await request(empty, 'export', {})).status, 409)
    })
    await t.test(
      'export serializes edits, decisions and repeated sends for one document',
      async () => {
        const id = await doc('approved')
        const [run] = await db
          .insert(workflowRuns)
          .values({
            documentId: id,
            step: 'extraction',
            state: 'failed',
            correlationId: randomUUID(),
          })
          .returning()
        const entered = deferred(),
          release = deferred()
        let sends = 0
        send = async (payload) => {
          sends++
          payloads.push(payload)
          entered.resolve()
          await release.promise
          return 'exports/concurrent.json'
        }
        const exporting = request(id, 'export', {})
        await entered.promise
        const blocked = [
          request(id, 'fields/total', { value: '-5' }, 'PATCH'),
          request(id, 'reject', { reason: 'other', comment: 'test' }),
          request(id, 'reprocess'),
          request(id, 'type', { type: 'invoice' }),
          request(id, 'approve'),
          runRequest(run.id, 'manual'),
          runRequest(run.id, 'retry'),
        ]
        const repeated = request(id, 'export', {})
        release.resolve()
        assert.equal((await exporting).status, 201)
        for (const result of await Promise.all(blocked))
          assert.ok([400, 409].includes(result.status), JSON.stringify(result))
        assert.equal((await repeated).status, 201)
        assert.equal(sends, 1)
        assert.equal((await row(id)).status, 'exported')
        assert.equal(
          (await db.select().from(documentExports).where(eq(documentExports.documentId, id)))
            .length,
          1,
        )
        send = async (payload) => {
          payloads.push(payload)
          return 'exports/test.json'
        }
      },
    )
    await t.test('edit winning the lock prevents a later export of the invalid value', async () => {
      const id = await doc('approved')
      const entered = deferred(),
        release = deferred()
      const original = validation.runInTransaction.bind(validation)
      validation.runInTransaction = async (...args) => {
        entered.resolve()
        await release.promise
        return original(...args)
      }
      const editing = request(id, 'fields/total', { value: '-5' }, 'PATCH')
      await entered.promise
      const exporting = request(id, 'export', {})
      release.resolve()
      assert.equal((await editing).status, 200)
      assert.equal((await exporting).status, 400)
      validation.runInTransaction = original
    })
    await t.test(
      'concurrent reprocess requests enqueue one revision; queue failure rolls back',
      async () => {
        const id = await doc()
        const before = jobs.length
        const results = await Promise.all([request(id, 'reprocess'), request(id, 'reprocess')])
        assert.deepEqual(results.map((r) => r.status).toSorted(), [201, 400])
        assert.equal(jobs.length, before + 1)
        assert.equal(jobs.at(-1).data.revision, 1)
        const fresh = await doc()
        const original = queue.add
        queue.add = async () => {
          throw new Error('queue unavailable')
        }
        assert.equal((await request(fresh, 'reprocess')).status, 500)
        assert.equal((await row(fresh)).status, 'needs_review')
        assert.equal((await row(fresh)).processingRevision, 0)
        queue.add = original
      },
    )
    await t.test(
      'stale extraction success, invalid response and provider failure preserve manual decisions',
      async () => {
        for (const error of [
          null,
          new LlmInvalidResponseError('invalid'),
          new Error('provider unavailable'),
        ]) {
          const id = await doc('processing', {}, 'extraction')
          const entered = deferred(),
            release = deferred()
          const llm = {
            external: false,
            async extract() {
              entered.resolve()
              await release.promise
              if (error) throw error
              return { fields: specs.map((s) => ({ name: s.name, value: null, evidence: null })) }
            },
          }
          const processor = new ExtractProcessor(db, {}, llm, events, queue, validation)
          const work = processor
            .process({
              data: { documentId: id, correlationId: randomUUID(), revision: 0 },
              opts: { attempts: 1 },
              attemptsMade: 0,
            })
            .catch((e) => e)
          await entered.promise
          const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.documentId, id))
          assert.equal((await runRequest(run.id, 'manual')).status, 201)
          assert.equal((await read(id)).fields.length, 2)
          await request(id, 'fields/name', { value: 'Manual' }, 'PATCH')
          await request(id, 'fields/total', { value: '40' }, 'PATCH')
          assert.equal((await request(id, 'approve')).status, 201)
          release.resolve()
          await work
          const final = await read(id)
          assert.equal(final.status, 'approved')
          assert.equal(final.fields.find((f) => f.name === 'name').normalizedValue, 'Manual')
          assert.equal(final.issues.filter((i) => i.severity === 'blocking').length, 0)
        }
      },
    )
    await t.test('in-flight extraction cannot overwrite a newer extraction revision', async () => {
      const id = await doc('processing', {}, 'extraction')
      await db
        .insert(pages)
        .values({ documentId: id, pageNumber: 1, ocrText: 'original', width: 100, height: 100 })
      const entered = deferred(),
        release = deferred()
      const processor = new ExtractProcessor(
        db,
        {},
        {
          external: false,
          async extract() {
            entered.resolve()
            await release.promise
            return { fields: specs.map((s) => ({ name: s.name, value: null, evidence: null })) }
          },
        },
        events,
        queue,
        validation,
      )
      const work = processor.process({
        data: { documentId: id, correlationId: randomUUID(), revision: 0 },
        opts: { attempts: 1 },
        attemptsMade: 0,
      })
      await entered.promise
      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.documentId, id))
      await runRequest(run.id, 'manual')
      await request(id, 'fields/name', { value: 'Keep until replacement succeeds' }, 'PATCH')
      assert.equal((await request(id, 'type', { type: 'contract' })).status, 201)
      const revision = (await row(id)).processingRevision
      const before = jobs.length
      release.resolve()
      await work
      assert.equal((await row(id)).processingStep, 'extraction')
      assert.equal((await row(id)).processingRevision, revision)
      assert.equal(jobs.length, before)
      assert.equal(
        (await read(id)).fields.find((f) => f.name === 'name').normalizedValue,
        'Keep until replacement succeeds',
      )
    })
    await t.test(
      'all five processors advance their expected stage through a complete pipeline',
      async () => {
        const id = await doc('received', {}, 'preprocess')
        const buffer = await readFile(new URL('./fixtures/sample-invoice.pdf', import.meta.url))
        const storage = {
          async getBuffer() {
            return buffer
          },
          async put() {},
        }
        const llm = {
          external: false,
          async classify() {
            return { document_type: 'contract', confidence: 1, multi_document_suspected: false }
          },
          async extract() {
            return {
              fields: [
                { name: 'name', value: 'Original', evidence: null },
                { name: 'total', value: '10', evidence: null },
              ],
            }
          },
        }
        const processors = [
          new PreprocessProcessor(db, {}, storage, events, queue),
          new OcrProcessor(db, {}, new MockOcrProvider(), storage, events, queue),
          new ClassifyProcessor(db, {}, llm, events, queue),
          new ExtractProcessor(db, {}, llm, events, queue, validation),
          new ValidateProcessor(db, {}, validation, events),
        ]
        let data = { documentId: id, correlationId: randomUUID(), revision: 0 }
        for (const [index, processor] of processors.entries()) {
          await processor.process({ data, opts: { attempts: 1 }, attemptsMade: 0 })
          if (index < 4) {
            assert.equal(jobs.at(-1).data.documentId, id)
            data = jobs.at(-1).data
          }
        }
        assert.equal((await row(id)).processingStep, null)
        const detail = await read(id)
        assert.equal(detail.status, 'needs_review')
        assert.equal(detail.canApprove, true)
        assert.equal(
          (await db.select().from(workflowRuns).where(eq(workflowRuns.documentId, id))).filter(
            (r) => r.state === 'succeeded',
          ).length,
          5,
        )
      },
    )
    await t.test(
      'obsolete queued jobs in every stage skip providers, writes and downstream queues',
      async () => {
        const id = await doc('processing', {}, 'preprocess')
        await db.update(documents).set({ processingRevision: 2 }).where(eq(documents.id, id))
        const never = new Proxy(
          {},
          {
            get() {
              throw new Error('obsolete job invoked provider')
            },
          },
        )
        const processors = [
          new PreprocessProcessor(db, {}, never, events, queue),
          new OcrProcessor(db, {}, never, never, events, queue),
          new ClassifyProcessor(db, {}, never, events, queue),
          new ExtractProcessor(db, {}, never, events, queue, validation),
          new ValidateProcessor(db, {}, never, events),
        ]
        const before = jobs.length
        for (const processor of processors)
          await processor.process({
            data: { documentId: id, correlationId: randomUUID(), revision: 1 },
          })
        assert.equal(jobs.length, before)
        assert.equal(
          (await db.select().from(workflowRuns).where(eq(workflowRuns.documentId, id))).length,
          0,
        )
      },
    )
    await t.test('OCR writes cannot replace pages after manual handling', async () => {
      const id = await doc('processing', {}, 'ocr')
      await db
        .insert(pages)
        .values({ documentId: id, pageNumber: 1, ocrText: 'original', width: 100, height: 100 })
      const entered = deferred(),
        release = deferred()
      const processor = new OcrProcessor(
        db,
        {},
        {
          external: false,
          async recognize() {
            entered.resolve()
            await release.promise
            return { pages: [] }
          },
        },
        {
          async getBuffer() {
            return Buffer.from('test')
          },
        },
        events,
        queue,
      )
      const work = processor.process({
        data: { documentId: id, correlationId: randomUUID() },
        opts: { attempts: 1 },
        attemptsMade: 0,
      })
      await entered.promise
      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.documentId, id))
      assert.equal((await runRequest(run.id, 'manual')).status, 201)
      release.resolve()
      await work
      assert.equal(
        (await db.select().from(pages).where(eq(pages.documentId, id)))[0].ocrText,
        'original',
      )
    })
  },
)
