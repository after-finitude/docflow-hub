import 'reflect-metadata'
import { PDFDocument, PDFName } from 'pdf-lib'
import { UPLOAD_MAX_BYTES } from '@docflow/shared'
import { OversizedUploadFilter } from '../apps/api/dist/documents/oversized-upload.filter.js'
import { RetentionService } from '../apps/worker/dist/sync/retention.service.js'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, cp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockOcrProvider } from '../apps/worker/dist/ocr/mock-ocr.provider.js'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { Module } from '@nestjs/common'
import { NestFactory, Reflector } from '@nestjs/core'
import { RolesGuard } from '../apps/api/dist/auth/roles.guard.js'
import { SchemasController } from '../apps/api/dist/schemas/schemas.controller.js'
import { ExportSettingsController } from '../apps/api/dist/export/export-settings.controller.js'
import {
  ENV,
  IngestService,
  DB,
  auditEvents,
  externalCallRecorder,
  auditedExternalCall,
  getActiveSchema,
  seedSchemas,
  SEED_SCHEMAS,
  loadEnv,
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
import { FileJsonAdapter } from '../apps/api/dist/export/file-json.adapter.js'
import { GoogleSheetsAdapter } from '../apps/api/dist/export/google-sheets.adapter.js'
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
const httpStatus = (code) => (error) => error.getStatus() === code
const specs = [
  { name: 'name', label: 'Name', type: 'string', required: true, critical: true },
  { name: 'total', label: 'Total', type: 'number', required: true, critical: false },
]
const rules = [
  { id: 'positive', field: 'total', type: 'number_range', min: 0, severity: 'blocking' },
]

const configuration = (dto) => ({
  fields: dto.fields,
  rules: dto.rules,
  thresholds: dto.thresholds,
  exportMapping: dto.exportMapping,
})

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
    await t.test(
      'actual application login can append audit but cannot alter audit or schema',
      { skip: !process.env.TEST_APP_DB_PASSWORD },
      async () => {
        const appUrl = new URL(url)
        appUrl.username = 'docflow_app'
        appUrl.password = process.env.TEST_APP_DB_PASSWORD
        const appPool = new Pool({ connectionString: appUrl.href })
        try {
          assert.equal(
            (await appPool.query('select current_user')).rows[0].current_user,
            'docflow_app',
          )
          const appDb = drizzle(appPool)
          const correlationId = randomUUID()
          const record = externalCallRecorder(appDb, {
            documentId: randomUUID(),
            correlationId,
            runId: randomUUID(),
            provider: 'controlled',
          })
          await assert.rejects(
            auditedExternalCall(
              record,
              { purpose: 'extraction', pages: [2], fields: ['total'], attempt: 1 },
              async () => {
                throw new Error('controlled failure')
              },
            ),
          )
          await auditedExternalCall(
            record,
            { purpose: 'extraction', pages: [2], fields: ['total'], attempt: 2 },
            async () => 'repaired',
          )
          const journal = (
            await appPool.query(
              'select after from audit_events where correlation_id = $1 order by created_at',
              [correlationId],
            )
          ).rows.map((row) => row.after)
          assert.deepEqual(
            journal.map((row) => row.state),
            ['attempted', 'failed', 'attempted', 'succeeded'],
          )
          assert.ok(journal.every((row) => row.pages[0] === 2 && row.fields[0] === 'total'))
          for (const sql of [
            'update audit_events set result = result',
            'delete from audit_events',
            'truncate audit_events',
            'create table forbidden_probe (id int)',
          ]) {
            await assert.rejects(appPool.query(sql), (error) => error.code === '42501', sql)
          }
          assert.equal(
            (
              await appPool.query('select count(*) from audit_events where correlation_id = $1', [
                correlationId,
              ])
            ).rows[0].count,
            '4',
          )
        } finally {
          await appPool.end()
        }
      },
    )
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
        exportMapping: [{ column: 'Name', source: 'field:name' }],
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
    const adapters = [
      {
        destination: 'file_json',
        async reserve(_db, id) {
          return { kind: 'file_json', objectKey: `exports/${id}.json` }
        },
        send: (...args) => send(...args),
      },
    ]
    const exports = new ExportService(db, adapters, events, {}, validation, pool, {
      EXPORT_DEFAULT_DESTINATION: 'file_json',
    })
    const storedUploads = []
    const ingest = new IngestService(
      db,
      {
        async put(key, buffer) {
          storedUploads.push({ key, bytes: buffer.length })
        },
      },
      events,
      queue,
    )
    const service = new DocumentsService(db, {}, events, validation, ingest, exports, queue, queue)
    const runs = new RunsService(db, events, queue, queue, queue, queue, queue, validation)
    // eslint-disable-next-line typescript/no-extraneous-class -- Nest module metadata.
    class TestModule {}
    Module({
      controllers: [
        DocumentsController,
        RunsController,
        SchemasController,
        ExportSettingsController,
      ],
      providers: [
        OversizedUploadFilter,
        { provide: DB, useValue: db },
        { provide: DocumentsService, useValue: service },
        { provide: RunsService, useValue: runs },
        { provide: PageRenderService, useValue: {} },
        { provide: ExportService, useValue: exports },
        { provide: ENV, useValue: {} },
      ],
    })(TestModule)
    const app = await NestFactory.create(TestModule, { logger: false })
    app.use((req, _res, next) => {
      req.user = req.headers['x-test-role'] === 'admin' ? { ...user, role: 'admin' } : user
      next()
    })
    app.useGlobalGuards(new RolesGuard(app.get(Reflector)))
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
          schemaVersionId: schema.id,
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
      'retention keeps inactive originals for exactly 90 days and preserves active documents',
      async () => {
        const id = await doc()
        const active = await doc()
        const deactivatedAt = new Date('2020-01-01T00:00:00Z')
        await db
          .update(documents)
          .set({ isActive: false, deactivatedAt })
          .where(eq(documents.id, id))
        const removed = []
        const retention = new RetentionService(
          db,
          { RETENTION_DAYS: 90, ORPHAN_TTL_HOURS: 24 },
          {
            async removePrefix(prefix) {
              removed.push(prefix)
            },
            async list() {
              return []
            },
          },
        )
        const boundary = new Date(deactivatedAt.getTime() + 90 * 86400000)
        assert.equal((await retention.run(randomUUID(), boundary)).purgedDocuments, 0)
        assert.ok(await row(id))
        assert.equal(
          (await retention.run(randomUUID(), new Date(boundary.getTime() + 1))).purgedDocuments,
          1,
        )
        assert.equal(await row(id), undefined)
        assert.ok(await row(active))
        assert.equal(removed.length, 1)
        assert.ok(
          (await db.select().from(auditEvents).where(eq(auditEvents.objectId, id))).some(
            (e) => e.action === 'document.purged',
          ),
        )
      },
    )

    await t.test(
      'review timing is idempotent, actor/revision specific, and metrics are administrator-only',
      async () => {
        const id = await doc('needs_review')
        await Promise.all([service.openReview(id, user, {}), service.openReview(id, user, {})])
        let logs = await db.select().from(auditEvents).where(eq(auditEvents.objectId, id))
        assert.equal(logs.filter((log) => log.action === 'document.review_opened').length, 1)
        assert.equal((await request(id, 'approve')).status, 201)
        logs = await db.select().from(auditEvents).where(eq(auditEvents.objectId, id))
        const approval = logs.find((log) => log.action === 'document.approved')
        assert.ok(approval.after.reviewDurationMs >= 0)
        assert.ok(approval.after.reviewOpenedAt)
        assert.ok(approval.after.approvedAt)
        const [other] = await db
          .insert(users)
          .values({ login: 'reviewer', passwordHash: 'test', role: 'operator' })
          .returning()
        const otherActor = await doc('needs_review')
        await service.openReview(otherActor, other, {})
        assert.equal((await request(otherActor, 'approve')).status, 201)
        const otherApproval = (
          await db.select().from(auditEvents).where(eq(auditEvents.objectId, otherActor))
        ).find((log) => log.action === 'document.approved')
        assert.equal(otherApproval.after.reviewDurationMs, null)
        const stale = await doc('needs_review')
        await service.openReview(stale, user, {})
        await db.update(documents).set({ processingRevision: 1 }).where(eq(documents.id, stale))
        assert.equal((await request(stale, 'approve')).status, 201)
        const staleApproval = (
          await db.select().from(auditEvents).where(eq(auditEvents.objectId, stale))
        ).find((log) => log.action === 'document.approved')
        assert.equal(staleApproval.after.reviewDurationMs, null)
        assert.equal((await fetch(`${base}/documents/review-metrics`)).status, 403)
        const response = await fetch(`${base}/documents/review-metrics`, {
          headers: { 'x-test-role': 'admin' },
        })
        assert.equal(response.status, 200)
        const metrics = await response.json()
        assert.equal(metrics.review.measured, 1)
        assert.equal(metrics.review.missingOpening, 2)
        assert.equal(metrics.review.medianMs, approval.after.reviewDurationMs)
        assert.equal(
          (
            await fetch(`${base}/documents/review-metrics?since=bad`, {
              headers: { 'x-test-role': 'admin' },
            })
          ).status,
          400,
        )
      },
    )

    await t.test(
      'oversized metadata creates a rejected document, failed ingest and audit without storage or jobs',
      async () => {
        const beforeJobs = jobs.length,
          beforeStorage = storedUploads.length
        const reply = await request('oversized', '', {
          filename: 'large.pdf',
          mimeType: 'application/pdf',
          sizeBytes: UPLOAD_MAX_BYTES + 100,
        })
        assert.equal(reply.status, 201)
        const id = reply.body.id,
          detail = await read(id)
        assert.equal(detail.status, 'rejected')
        assert.equal(detail.hasOriginal, false)
        assert.equal(detail.sizeBytes, UPLOAD_MAX_BYTES + 100)
        assert.equal(detail.checksum, null)
        assert.equal((await row(id)).storageKey, null)
        assert.equal(detail.canApprove, false)
        assert.equal(jobs.length, beforeJobs)
        assert.equal(storedUploads.length, beforeStorage)
        const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.documentId, id))
        assert.equal(run.state, 'failed')
        assert.equal(run.errorCode, 'file_too_large')
        const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.objectId, id))
        assert.equal(audit.actorId, user.id)
        assert.equal(audit.after.originalStored, false)
        assert.equal(audit.after.sizeSource, 'client_metadata')
        assert.equal((await request(id, 'reprocess')).status, 400)
        assert.equal((await request(id, 'file', undefined, 'GET')).status, 404)
        assert.equal((await request(id, 'pages/1/image', undefined, 'GET')).status, 404)
        assert.equal((await runRequest(run.id, 'retry')).status, 400)
        assert.equal((await runRequest(run.id, 'manual')).status, 400)
        assert.equal((await request(id, 'approve')).status, 400)
        assert.equal((await request(id, 'export', {})).status, 400)
        await assert.rejects(
          db.update(documents).set({ status: 'approved' }).where(eq(documents.id, id)),
        )
        for (const body of [
          { filename: 'x.pdf', mimeType: 'application/pdf', sizeBytes: UPLOAD_MAX_BYTES },
          { filename: '', mimeType: 'application/pdf', sizeBytes: UPLOAD_MAX_BYTES + 1 },
          {
            filename: 'x.exe',
            mimeType: 'application/octet-stream',
            sizeBytes: UPLOAD_MAX_BYTES + 1,
          },
        ])
          assert.equal((await request('oversized', '', body)).status, 400)
        const listing = await fetch(`${base}/documents?status=rejected`).then((r) => r.json())
        assert.ok(listing.items.some((item) => item.id === id && !item.hasOriginal))
      },
    )
    await t.test(
      'raw multipart limit records the refusal and accepts the inclusive 25 MB boundary',
      async () => {
        const beforeJobs = jobs.length,
          beforeStorage = storedUploads.length
        const prior = await doc('needs_review')
        for (const path of ['/documents', `/documents/${prior}/file`]) {
          const body = new FormData()
          body.append(
            'file',
            new Blob([Buffer.alloc(UPLOAD_MAX_BYTES + 1)], { type: 'application/pdf' }),
            'oversized.pdf',
          )
          const response = await fetch(`${base}${path}`, { method: 'POST', body })
          assert.equal(response.status, 413)
          const reply = await response.json(),
            detail = await read(reply.documentId)
          assert.equal(detail.status, 'rejected')
          assert.equal(detail.sizeBytes, null)
          assert.equal(detail.hasOriginal, false)
        }
        assert.equal((await row(prior)).isActive, true)
        assert.equal(jobs.length, beforeJobs)
        assert.equal(storedUploads.length, beforeStorage)
        const body = new FormData()
        body.append(
          'file',
          new Blob([Buffer.alloc(UPLOAD_MAX_BYTES)], { type: 'application/pdf' }),
          'boundary.pdf',
        )
        const response = await fetch(`${base}/documents`, { method: 'POST', body })
        assert.equal(response.status, 201)
        const detail = await response.json()
        assert.equal(detail.hasOriginal, true)
        assert.equal(detail.sizeBytes, UPLOAD_MAX_BYTES)
        assert.equal(storedUploads.length, beforeStorage + 1)
        assert.equal(jobs.length, beforeJobs + 1)
      },
    )
    await t.test('retention of metadata-only refusals never removes a storage prefix', async () => {
      const reply = await request('oversized', '', {
        filename: 'expired.pdf',
        mimeType: 'application/pdf',
        sizeBytes: UPLOAD_MAX_BYTES + 1,
      })
      const id = reply.body.id
      await db
        .update(documents)
        .set({ isActive: false, deactivatedAt: new Date('2020-01-01') })
        .where(eq(documents.id, id))
      const removed = []
      const retention = new RetentionService(
        db,
        { RETENTION_DAYS: 30, ORPHAN_TTL_HOURS: 24 },
        {
          async removePrefix(prefix) {
            removed.push(prefix)
            return 1
          },
          async list() {
            return [{ key: 'documents/orphan/original.pdf', lastModified: new Date('2020-01-01') }]
          },
        },
      )
      const summary = await retention.run(randomUUID())
      assert.equal(summary.purgedDocuments, 1)
      assert.equal(summary.removedObjects, 1)
      assert.deepEqual(removed, ['documents/orphan/'])
      assert.equal(await row(id), undefined)
    })
    await t.test(
      'corrupt later pages and encrypted PDFs are rejected before any OCR or LLM call',
      async () => {
        const pdf = await PDFDocument.create()
        pdf.addPage([300, 400]).drawText('Valid first page')
        const second = pdf.addPage([300, 400])
        second.node.set(
          PDFName.of('Contents'),
          pdf.context.register(
            pdf.context.stream(Buffer.from('broken zlib'), { Filter: 'FlateDecode' }),
          ),
        )
        const broken = Buffer.from(await pdf.save({ useObjectStreams: false }))
        const encrypted = await readFile('scripts/fixtures/password-protected.pdf')
        for (const buffer of [broken, encrypted, Buffer.alloc(0), Buffer.from('not PDF')]) {
          const id = await doc('received', {}, 'preprocess'),
            before = jobs.length
          const storage = {
            async getBuffer() {
              return buffer
            },
            async put() {
              throw new Error('invalid file wrote a thumbnail')
            },
          }
          await new PreprocessProcessor(db, {}, storage, events, queue).process({
            data: { documentId: id, correlationId: randomUUID() },
          })
          assert.equal((await row(id)).status, 'rejected')
          assert.equal(jobs.length, before)
          const never = new Proxy(
            {},
            {
              get() {
                throw new Error('invalid file reached a provider')
              },
            },
          )
          for (const processor of [
            new OcrProcessor(db, {}, never, never, events, queue),
            new ClassifyProcessor(db, {}, never, events, queue),
            new ExtractProcessor(db, {}, never, events, queue, validation),
          ])
            await processor.process({ data: { documentId: id, correlationId: randomUUID() } })
          const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.documentId, id))
          assert.equal(run.state, 'failed')
          assert.equal(jobs.length, before)
        }
      },
    )
    await t.test(
      'classification skips leading and middle blank pages, preserves sources, and still limits input to two pages',
      async () => {
        for (const suspected of [false, true]) {
          const id = await doc('processing', {}, 'ocr')
          const block = {
            text: 'Original 10',
            confidence: 1,
            bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
          }
          const provider = {
            external: true,
            name: 'controlled-ocr',
            async recognize() {
              return {
                pages: [1, 2, 3, 4, 5, 6].map((pageNumber) => {
                  const blank = [1, 2, 4].includes(pageNumber)
                  return {
                    pageNumber,
                    width: 300,
                    height: 400,
                    text: blank ? (pageNumber === 1 ? '\t \r\n' : '') : block.text,
                    confidence: blank ? null : 1,
                    blocks: blank ? [] : [block],
                    sentToProvider: !blank,
                    blank,
                    rotationDegrees: pageNumber === 3 ? -7 : 0,
                    providerCalls: blank ? 0 : pageNumber === 3 ? 2 : 1,
                  }
                }),
              }
            },
          }
          const llm = {
            external: false,
            async classify({ pagesText }) {
              assert.deepEqual(
                pagesText.map((page) => page.page),
                [3, 5],
              )
              return {
                document_type: 'contract',
                confidence: 1,
                multi_document_suspected: suspected,
              }
            },
            async extract({ pagesText }) {
              assert.deepEqual(
                pagesText.map((page) => page.page),
                [3, 5, 6],
              )
              return {
                fields: [
                  { name: 'name', value: 'Original', evidence: { page: 5, text: 'Original' } },
                  { name: 'total', value: '10', evidence: { page: 5, text: '10' } },
                ],
              }
            },
          }
          const processors = [
            new OcrProcessor(
              db,
              {},
              provider,
              {
                async getBuffer() {
                  return Buffer.from('controlled')
                },
              },
              events,
              queue,
            ),
            new ClassifyProcessor(db, {}, llm, events, queue),
            new ExtractProcessor(db, {}, llm, events, queue, validation),
            new ValidateProcessor(db, {}, validation, events),
          ]
          let data = { documentId: id, correlationId: randomUUID() }
          for (const [index, processor] of processors.entries()) {
            await processor.process({ data, opts: { attempts: 1 }, attemptsMade: 0 })
            if (index < 3) data = jobs.at(-1).data
          }
          const detail = await read(id)
          assert.equal(detail.status, suspected ? 'needs_review' : 'approved')
          assert.equal(
            detail.issues.some((issue) => issue.ruleId === 'multi_document_suspected'),
            suspected,
          )
          assert.equal(
            detail.issues.some((issue) => issue.ruleId === 'ocr_quality'),
            false,
          )
          const storedPages = await service.pages(id)
          assert.deepEqual(
            storedPages.map((page) => page.pageNumber),
            [1, 2, 3, 4, 5, 6],
          )
          assert.ok(detail.fields.every((field) => field.sourceFound && field.sourcePage === 5))
          const audit = (
            await db.select().from(auditEvents).where(eq(auditEvents.objectId, id))
          ).find((entry) => entry.action === 'document.ocr_external')
          assert.deepEqual(audit.after.pages, [3, 5, 6])
          assert.equal(audit.after.corrections[0].providerCalls, 2)
          if (suspected) {
            await request(id, 'fields/total', { value: '10' }, 'PATCH')
            assert.equal((await read(id)).status, 'needs_review')
            assert.equal(
              (await read(id)).issues.some((issue) => issue.ruleId === 'multi_document_suspected'),
              true,
            )
          }
        }
      },
    )

    await t.test(
      'classification of only empty OCR pages needs review without an LLM call',
      async () => {
        const id = await doc('processing', {}, 'classification')
        await db.insert(pages).values(
          [null, '', '\t \r\n'].map((ocrText, index) => ({
            documentId: id,
            pageNumber: index + 1,
            ocrText,
            width: 300,
            height: 400,
            blocks: [],
          })),
        )
        const before = jobs.length
        const llm = { classify: async () => assert.fail('Empty pages must not reach the LLM') }
        await new ClassifyProcessor(db, {}, llm, events, queue).process({
          data: { documentId: id, correlationId: randomUUID() },
          opts: { attempts: 1 },
          attemptsMade: 0,
        })
        const detail = await read(id)
        assert.equal(detail.status, 'needs_review')
        assert.equal(detail.documentType, 'unknown')
        assert.equal(jobs.length, before)
      },
    )

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
    await t.test(
      'an export needs one connection and stays within its limit and lock timeout',
      async () => {
        let hold = null
        const limitedAdapters = [
          {
            destination: 'file_json',
            async reserve(_db, id) {
              return { kind: 'file_json', objectKey: `exports/${id}.json` }
            },
            async send() {
              if (hold) {
                hold.entered.resolve()
                await hold.release.promise
              }
              return 'exports/limited.json'
            },
          },
        ]
        const opened = []
        const exporter = (options, limit) => {
          const limited = new Pool({
            connectionString: url.href,
            connectionTimeoutMillis: 2000,
            ...options,
          })
          opened.push(limited)
          const limitedDb = drizzle(limited)
          const limitedService = new ExportService(
            limitedDb,
            limitedAdapters,
            events,
            {},
            new ValidationRunnerService(limitedDb, {}),
            limited,
            { EXPORT_DEFAULT_DESTINATION: 'file_json', EXPORT_MAX_CONCURRENT: limit },
          )
          return { limited, limitedService }
        }
        try {
          // The default destination is read over the export's own connection; a
          // second checkout would time out on a one-connection pool.
          const single = exporter({ max: 1 }, 1).limitedService
          assert.equal(
            (await single.export(await doc('approved'), {}, user, {})).status,
            'succeeded',
          )

          const { limited, limitedService } = exporter({ max: 3, statement_timeout: 500 }, 2)
          const id = await doc('approved')
          const other = await doc('approved')
          hold = { entered: deferred(), release: deferred() }
          const sending = limitedService.export(id, {}, user, {})
          await hold.entered.promise
          // Waits for the session lock until statement_timeout cancels the wait.
          const waiting = assert.rejects(limitedService.export(id, {}, user, {}), httpStatus(409))
          await assert.rejects(limitedService.export(other, {}, user, {}), httpStatus(503))
          assert.equal((await limited.query('select 1 as ok')).rows[0].ok, 1)
          await waiting
          hold.release.resolve()
          assert.equal((await sending).status, 'succeeded')
          hold = null
          assert.equal((await limitedService.export(other, {}, user, {})).status, 'succeeded')
        } finally {
          hold?.release.resolve()
          await Promise.all(opened.map((limited) => limited.end()))
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
    await t.test(
      'export keys reject conflicting document/destination reuse, including concurrent requests',
      async () => {
        const first = await doc('approved'),
          second = await doc('approved')
        const exportKey = randomUUID()
        const before = payloads.length
        const results = await Promise.all([
          request(first, 'export', { exportKey }),
          request(second, 'export', { exportKey }),
        ])
        assert.deepEqual(results.map((r) => r.status).toSorted(), [201, 409])
        assert.equal(payloads.length, before + 1)
        const winner = results[0].status === 201 ? first : second
        assert.equal(
          (await request(winner, 'export', { destination: 'google_sheets', exportKey })).status,
          409,
        )
        assert.equal(
          (await request(winner, 'export', { exportKey })).body.id,
          results.find((r) => r.status === 201).body.id,
        )
      },
    )

    await t.test('JSON object names cannot collide for punctuation or Unicode keys', async () => {
      const objects = new Map()
      adapters[0] = new FileJsonAdapter({
        async put(key, buffer) {
          objects.set(key, buffer.toString())
        },
      })
      const id = await doc('approved')
      const keys = ['a:b', 'a/b', 'a_b', 'документ', '文件']
      const records = []
      for (const exportKey of keys) {
        const response = await request(id, 'export', { exportKey })
        assert.equal(response.status, 201)
        assert.equal(response.body.status, 'succeeded')
        records.push(response.body)
      }
      assert.equal(objects.size, keys.length)
      assert.equal(new Set(records.map((r) => r.payloadRef)).size, keys.length)
      assert.equal(
        (await db.select().from(workflowRuns).where(eq(workflowRuns.documentId, id))).length,
        keys.length,
      )
    })

    await t.test(
      'lost JSON response preserves Approved and retries identical saved bytes and mapping',
      async () => {
        const objects = new Map(),
          writes = []
        let loseResponse = true
        adapters[0] = new FileJsonAdapter({
          async put(key, buffer) {
            const text = buffer.toString()
            objects.set(key, text)
            writes.push({ key, text })
            if (loseResponse) {
              loseResponse = false
              throw new Error('response lost after object write')
            }
          },
        })
        const id = await doc('approved')
        const response = await request(id, 'export', { exportKey: 'saved-json' })
        assert.equal(response.body.status, 'failed')
        assert.equal((await row(id)).status, 'approved')
        assert.equal((await row(id)).processingStep, 'export')
        const [saved] = await db
          .select()
          .from(documentExports)
          .where(eq(documentExports.id, response.body.id))
        assert.ok(saved.canonicalPayload && saved.mappingSnapshot && saved.target)
        const [failedRun] = await db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.exportId, saved.id))
        assert.equal(failedRun.state, 'failed')
        assert.equal(failedRun.attempts, 1)
        assert.equal(failedRun.errorCode, 'storage_unavailable')
        for (const [action, body, method] of [
          ['fields/name', { value: 'Unsafe change' }, 'PATCH'],
          ['reprocess', undefined, 'POST'],
          ['reject', { reason: 'other', comment: 'test' }, 'POST'],
          ['type', { type: 'invoice' }, 'POST'],
        ])
          assert.equal((await request(id, action, body, method)).status, 409)
        // An out-of-band mapping change must not alter an already saved export.
        const oldMapping = schema.exportMapping
        await db
          .update(documentSchemas)
          .set({ exportMapping: [{ column: 'changed after failure', source: 'field:name' }] })
          .where(eq(documentSchemas.id, schema.id))
        try {
          const retried = await request(id, 'export', { exportKey: 'saved-json' })
          assert.equal(retried.body.status, 'succeeded')
          assert.equal(retried.body.attempts, 2)
          assert.equal(retried.body.id, saved.id)
          assert.deepEqual(writes[0], writes[1])
          assert.equal(objects.size, 1)
          const [after] = await db
            .select()
            .from(documentExports)
            .where(eq(documentExports.id, saved.id))
          assert.deepEqual(after.mappingSnapshot, saved.mappingSnapshot)
          assert.deepEqual(after.canonicalPayload, saved.canonicalPayload)
          const [run] = await db
            .select()
            .from(workflowRuns)
            .where(eq(workflowRuns.exportId, saved.id))
          assert.equal(run.id, failedRun.id)
          assert.equal(run.state, 'succeeded')
          assert.equal(run.attempts, 2)
          assert.notEqual(run.correlationId, failedRun.correlationId)
          assert.equal(run.errorCode, null)
        } finally {
          await db
            .update(documentSchemas)
            .set({ exportMapping: oldMapping })
            .where(eq(documentSchemas.id, schema.id))
        }
      },
    )

    await t.test(
      'a database disconnect after destination write leaves a recoverable Pending export',
      async () => {
        const objects = new Map(),
          writes = []
        let disconnect = true
        adapters[0] = new FileJsonAdapter({
          async put(key, buffer) {
            objects.set(key, buffer.toString())
            writes.push(buffer.toString())
            if (disconnect) {
              disconnect = false
              const { rows: holders } = await pool.query(
                "select distinct l.pid from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and l.granted and a.datname=current_database()",
              )
              assert.equal(holders.length, 1)
              await pool.query('select pg_terminate_backend($1)', [holders[0].pid])
            }
          },
        })
        const id = await doc('approved')
        const first = await request(id, 'export', { exportKey: 'interrupted' })
        assert.equal(first.status, 500)
        const [pending] = await db
          .select()
          .from(documentExports)
          .where(eq(documentExports.documentId, id))
        assert.equal(pending.status, 'pending')
        assert.equal(pending.attempts, 1)
        assert.ok(pending.target && pending.canonicalPayload)
        const [run] = await db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.exportId, pending.id))
        assert.equal(run.state, 'running')
        assert.equal((await request(id, 'fields/total', { value: '99' }, 'PATCH')).status, 409)
        const retry = await request(id, 'export', { exportKey: 'interrupted' })
        assert.equal(retry.body.status, 'succeeded')
        assert.equal(retry.body.id, pending.id)
        assert.equal(retry.body.attempts, 2)
        assert.equal(objects.size, 1)
        assert.deepEqual(writes[0], writes[1])
      },
    )

    await t.test(
      'Sheets reserves distinct rows across documents and reuses identity after a lost response',
      async (subtest) => {
        const model = mockSheets()
        const options = {
          keyFile: 'unused',
          spreadsheetId: 'test-spreadsheet',
          sheetName: "O'Brien",
        }
        const adapter = new GoogleSheetsAdapter(options)
        subtest.mock.method(adapter, 'client', async () => model.client)
        adapters[1] = adapter
        const id = await doc('approved')
        model.loseResponse = true
        const failed = await request(id, 'export', {
          destination: 'google_sheets',
          exportKey: 'sheet-first',
        })
        assert.equal(failed.body.status, 'failed')
        const [saved] = await db
          .select()
          .from(documentExports)
          .where(eq(documentExports.id, failed.body.id))
        assert.equal(saved.target.row, 2)
        assert.equal(saved.target.sheetId, 7)
        const firstWrite = structuredClone(model.writes[0])
        // Other documents can reserve while this one awaits an operator retry.
        const ids = await Promise.all([doc('approved'), doc('approved'), doc('approved')])
        const results = await Promise.all(
          ids.map((documentId) => request(documentId, 'export', { destination: 'google_sheets' })),
        )
        assert.ok(
          results.every((r) => r.body.status === 'succeeded'),
          JSON.stringify(results),
        )
        // An out-of-band mapping change must not alter an already saved export.
        const oldMapping = schema.exportMapping
        await db
          .update(documentSchemas)
          .set({ exportMapping: [{ column: 'new mapping', source: 'field:name' }] })
          .where(eq(documentSchemas.id, schema.id))
        options.spreadsheetId = 'changed-config'
        options.sheetName = 'renamed-config'
        model.title = 'Renamed tab'
        try {
          const retry = await request(id, 'export', {
            destination: 'google_sheets',
            exportKey: 'sheet-first',
          })
          assert.equal(retry.body.status, 'succeeded')
          assert.deepEqual(model.writes.at(-1), firstWrite)
          assert.equal(model.rows.size, 5, 'one header plus exactly four document rows')
          assert.equal(
            new Set(
              model.writes.flatMap((w) =>
                w.data
                  .filter((d) => d.dataFilter.gridRange.startRowIndex > 0)
                  .map((d) => d.dataFilter.gridRange.startRowIndex),
              ),
            ).size,
            4,
          )
          assert.equal(model.reserveReads, 4, 'retry must not discover or allocate another row')
        } finally {
          await db
            .update(documentSchemas)
            .set({ exportMapping: oldMapping })
            .where(eq(documentSchemas.id, schema.id))
        }
      },
    )

    await t.test(
      'Sheets discovery failure is logged and no target write happens before reservation commits',
      async (subtest) => {
        const model = mockSheets()
        const adapter = new GoogleSheetsAdapter({
          keyFile: 'unused',
          spreadsheetId: 'test-spreadsheet-2',
          sheetName: "O'Brien",
        })
        model.spreadsheetId = 'test-spreadsheet-2'
        let unavailable = true
        subtest.mock.method(adapter, 'client', async () => {
          if (unavailable) throw Object.assign(new Error('destination unavailable'), { code: 503 })
          return model.client
        })
        adapters[1] = adapter
        const id = await doc('approved')
        const first = await request(id, 'export', { destination: 'google_sheets' })
        assert.equal(first.body.status, 'failed')
        assert.equal(model.writes.length, 0)
        const [saved] = await db
          .select()
          .from(documentExports)
          .where(eq(documentExports.id, first.body.id))
        assert.equal(saved.target, null)
        assert.ok(saved.canonicalPayload)
        unavailable = false
        model.beforeWrite = async () => {
          const [reserved] = await db
            .select()
            .from(documentExports)
            .where(eq(documentExports.id, saved.id))
          assert.ok(
            reserved.target,
            'another connection sees the committed address before the external write',
          )
        }
        assert.equal(
          (await request(id, 'export', { destination: 'google_sheets' })).body.status,
          'succeeded',
        )
        assert.equal(model.rows.size, 2)
      },
    )

    await t.test(
      'legacy successful exports remain idempotent; unsafe historical failures are not replayed',
      async () => {
        const id = await doc('exported')
        const [legacy] = await db
          .insert(documentExports)
          .values({
            documentId: id,
            destination: 'file_json',
            exportKey: 'legacy-success',
            status: 'succeeded',
            payloadRef: 'exports/old_path.json',
            attempts: 1,
          })
          .returning()
        assert.equal(
          (await request(id, 'export', { exportKey: legacy.exportKey })).body.payloadRef,
          legacy.payloadRef,
        )
        const [failed] = await db
          .insert(documentExports)
          .values({
            documentId: id,
            destination: 'google_sheets',
            exportKey: 'legacy-uncertain',
            status: 'failed',
            attempts: 1,
          })
          .returning()
        assert.equal(
          (
            await request(id, 'export', {
              exportKey: failed.exportKey,
              destination: 'google_sheets',
            })
          ).status,
          409,
        )
      },
    )
    await t.test(
      'Sheets rejects changed column layouts before writing, including pending header reservations',
      async (subtest) => {
        const model = mockSheets()
        model.spreadsheetId = 'layout-test'
        const adapter = new GoogleSheetsAdapter({
          keyFile: 'unused',
          spreadsheetId: model.spreadsheetId,
          sheetName: "O'Brien",
        })
        subtest.mock.method(adapter, 'client', async () => model.client)
        adapters[1] = adapter
        model.rows.set(0, ['Different header'])
        const mismatched = await request(await doc('approved'), 'export', {
          destination: 'google_sheets',
        })
        assert.equal(mismatched.body.status, 'failed')
        assert.equal(mismatched.body.errorCode, 'sheets_mapping_mismatch')
        assert.equal(model.writes.length, 0)
        model.rows.clear()
        model.beforeWrite = async () => {
          throw new Error('not written yet')
        }
        const pendingHeader = await request(await doc('approved'), 'export', {
          destination: 'google_sheets',
        })
        assert.equal(pendingHeader.body.status, 'failed')
        const [reserved] = await db
          .select()
          .from(documentExports)
          .where(eq(documentExports.id, pendingHeader.body.id))
        assert.equal(reserved.target.row, 2)
        await db
          .update(documentSchemas)
          .set({ exportMapping: [{ column: 'New layout', source: 'field:name' }] })
          .where(eq(documentSchemas.id, schema.id))
        try {
          const conflict = await request(await doc('approved'), 'export', {
            destination: 'google_sheets',
          })
          assert.equal(conflict.body.errorCode, 'sheets_mapping_mismatch')
          assert.equal(model.writes.length, 0)
        } finally {
          await db
            .update(documentSchemas)
            .set({ exportMapping: schema.exportMapping })
            .where(eq(documentSchemas.id, schema.id))
        }
      },
    )

    async function configRequest(path, body, role = 'admin', method = 'PUT') {
      const response = await fetch(`${base}/${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-role': role },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() }
    }
    const versions = async (type = 'contract') =>
      (await configRequest(`schemas/${type}/versions`, undefined, 'admin', 'GET')).body

    await t.test(
      'configuration mutations enforce the real RolesGuard and reject invalid definitions',
      async () => {
        const original = configuration(await getActiveSchema(db, 'contract'))
        for (const [path, body] of [
          ['schemas/contract', original],
          ['schemas/contract/thresholds', original.thresholds],
          ['settings/export', { defaultDestination: 'file_json' }],
        ])
          assert.equal((await configRequest(path, body, 'operator')).status, 403)
        assert.equal(
          (await configRequest('settings/export', undefined, 'operator', 'GET')).status,
          403,
        )
        assert.equal(
          (await configRequest('settings/export', undefined, 'admin', 'GET')).status,
          200,
        )
        const invalid = [
          { fields: [...original.fields, original.fields[0]] },
          {
            rules: [
              { id: 'missing', type: 'regex', field: 'absent', pattern: '.', severity: 'blocking' },
            ],
          },
          {
            rules: [
              { id: 'bad_regex', type: 'regex', field: 'name', pattern: '[', severity: 'blocking' },
            ],
          },
          {
            rules: [
              { id: 'type:name', type: 'regex', field: 'name', pattern: '.', severity: 'blocking' },
            ],
          },
          { rules: [original.rules[0], original.rules[0]] },
          { rules: [{ ...original.rules[0], min: 20, max: 10 }] },
          { rules: [{ ...original.rules[0], field: 'name' }] },
          { exportMapping: [{ column: 'Bad', source: 'meta:unsupported' }] },
          { exportMapping: [{ column: 'Bad', source: 'field:absent' }] },
          { exportMapping: [...original.exportMapping, original.exportMapping[0]] },
          { fields: [{ ...original.fields[0], type: 'enum', enumValues: [] }] },
        ]
        for (const patch of invalid) {
          const response = await configRequest('schemas/contract', { ...original, ...patch })
          assert.equal(response.status, 400, JSON.stringify(response))
        }
        assert.equal((await versions()).length, 1)
      },
    )

    await t.test(
      'old results retain labels, thresholds, validation and export mapping after configuration changes',
      async () => {
        adapters[0] = {
          destination: 'file_json',
          async reserve(_db, id) {
            return { kind: 'file_json', objectKey: `exports/${id}.json` }
          },
          async send() {
            return 'exports/versioned.json'
          },
        }
        const id = await doc('approved')
        // Simulate an old record whose fields predate the document-level binding.
        await db.update(documents).set({ schemaVersionId: null }).where(eq(documents.id, id))
        const config = configuration(await getActiveSchema(db, 'contract'))
        config.fields[0].label = 'Name v2'
        config.fields.push({
          name: 'note',
          label: 'Note v2',
          type: 'string',
          required: false,
          critical: false,
        })
        config.rules[0].min = 20
        config.thresholds.fieldConfidence = 0.99
        config.exportMapping = [{ column: 'Version two name', source: 'field:name' }]
        const updated = await configRequest('schemas/contract', config)
        assert.equal(updated.status, 200)
        assert.equal(updated.body.version, 2)
        assert.equal((await validation.run(id, { route: false })).decision.blockingCount, 0)
        const detail = await read(id)
        assert.equal(detail.schemaVersion, 1)
        assert.equal(detail.fields[0].label, 'Name')
        assert.equal(detail.fields.length, 2)
        assert.equal(detail.thresholds.fieldConfidence, schema.thresholds.fieldConfidence)
        const exported = await request(id, 'export', {})
        assert.equal(exported.body.status, 'succeeded', JSON.stringify(exported))
        const [record] = await db
          .select()
          .from(documentExports)
          .where(eq(documentExports.id, exported.body.id))
        assert.equal(record.canonicalPayload.schemaVersion, 1)
        assert.deepEqual(record.mappingSnapshot, schema.exportMapping)
        const [decision] = await pool
          .query(
            "select after from audit_events where object_id=$1 and action='document.validated' order by created_at desc limit 1",
            [id],
          )
          .then((r) => r.rows)
        assert.equal(decision.after.schemaVersion, 1)
        assert.equal(decision.after.schemaId, schema.id)
      },
    )

    await t.test(
      'in-flight extraction pins its version and successful replacement adopts it atomically',
      async () => {
        const id = await doc('processing', {}, 'extraction')
        await db.update(documents).set({ schemaVersionId: null }).where(eq(documents.id, id))
        const entered = deferred(),
          release = deferred()
        const processor = new ExtractProcessor(
          db,
          {},
          {
            external: false,
            async extract(input) {
              entered.resolve(input)
              await release.promise
              return {
                fields: input.fields.map((spec) => ({
                  name: spec.name,
                  value: spec.name === 'total' ? '30' : spec.name === 'name' ? 'New result' : null,
                  evidence: null,
                })),
              }
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
        const input = await Promise.race([
          entered.promise,
          work.then(() => assert.fail('provider was not called')),
        ])
        assert.equal(input.fields[0].label, 'Name v2')
        const config = configuration(await getActiveSchema(db, 'contract'))
        config.fields[0].label = 'Name v3'
        config.rules[0].min = 100
        const next = await configRequest('schemas/contract', config)
        assert.equal(next.status, 200)
        release.resolve()
        await work
        assert.equal((await read(id)).schemaVersion, 2)
        assert.equal((await read(id)).fields[0].label, 'Name v2')
        assert.equal((await validation.run(id, { route: false })).decision.blockingCount, 0)
        const resultVersion = (await row(id)).schemaVersionId
        assert.ok(
          (await db.select().from(fields).where(eq(fields.documentId, id))).every(
            (f) => f.schemaVersionId === resultVersion,
          ),
        )
        const audits = await db.select().from(auditEvents).where(eq(auditEvents.objectId, id))
        assert.ok(
          audits.some(
            (a) => a.action === 'document.schema_selected' && a.after.schemaVersion === 2,
          ),
        )
        assert.ok(
          audits.some((a) => a.action === 'document.schema_applied' && a.after.schemaVersion === 2),
        )
      },
    )

    await t.test(
      'explicit reprocessing selects a new version; provider retries and failed replacements preserve bindings',
      async () => {
        const id = await doc('needs_review')
        await db.insert(pages).values({ documentId: id, pageNumber: 1, ocrText: 'test' })
        const previous = (await read(id)).fields
        assert.equal((await request(id, 'type', { type: 'contract' })).status, 201)
        const job = {
          data: {
            documentId: id,
            correlationId: randomUUID(),
            revision: (await row(id)).processingRevision,
          },
          opts: { attempts: 2 },
          attemptsMade: 0,
        }
        const inputs = []
        let error = new Error('temporary provider failure')
        const processor = new ExtractProcessor(
          db,
          {},
          {
            external: false,
            async extract(input) {
              inputs.push(input)
              throw error
            },
          },
          events,
          queue,
          validation,
        )
        await assert.rejects(processor.process(job), /temporary provider failure/)
        const config = configuration(await getActiveSchema(db, 'contract'))
        config.fields[0].label = 'Name v4'
        assert.equal((await configRequest('schemas/contract', config)).status, 200)
        error = new LlmInvalidResponseError('repair exhausted')
        await processor.process({ ...job, attemptsMade: 1 })
        assert.deepEqual(
          inputs.map((input) => input.fields[0].label),
          ['Name v3', 'Name v3'],
        )
        const failed = await read(id)
        assert.equal(failed.status, 'needs_review')
        assert.equal(failed.schemaVersion, 1)
        assert.deepEqual(
          failed.fields.map((f) => [f.name, f.rawValue, f.label]),
          previous.map((f) => [f.name, f.rawValue, f.label]),
        )
        assert.equal((await request(id, 'reprocess')).status, 201)
        assert.equal((await row(id)).extractionSchemaVersionId, null)
        assert.equal((await row(id)).schemaVersionId, schema.id)
        const audits = await db.select().from(auditEvents).where(eq(auditEvents.objectId, id))
        assert.ok(
          audits.some(
            (a) => a.action === 'document.reprocess' && a.before.schemaVersionId === schema.id,
          ),
        )
      },
    )

    await t.test(
      'concurrent schema updates keep one active version and roll back if audit fails',
      async () => {
        const before = await versions()
        const changes = await Promise.all(
          [0.61, 0.62, 0.63].map((fieldConfidence) =>
            configRequest('schemas/contract/thresholds', {
              ...DEFAULT_THRESHOLDS,
              fieldConfidence,
            }),
          ),
        )
        assert.ok(
          changes.every((result) => result.status === 200),
          JSON.stringify(changes),
        )
        assert.equal(new Set(changes.map((result) => result.body.version)).size, 3)
        const after = await versions()
        assert.equal(after.length, before.length + 3)
        assert.equal(after.filter((version) => version.isActive).length, 1)
        await assert.rejects(
          db.insert(documentSchemas).values({
            documentType: 'contract',
            version: 999,
            jsonSchema: schema.jsonSchema,
            thresholds: schema.thresholds,
            isActive: true,
          }),
          (error) => error.cause?.code === '23505',
        )
        await pool.query(
          "CREATE FUNCTION reject_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'schema.updated' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$",
        )
        await pool.query(
          'CREATE TRIGGER reject_config_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_config_audit()',
        )
        try {
          const response = await configRequest('schemas/contract', configuration(after[0]))
          assert.equal(response.status, 500)
          assert.deepEqual(await versions(), after)
        } finally {
          await pool.query('DROP TRIGGER reject_config_audit ON audit_events')
          await pool.query('DROP FUNCTION reject_config_audit()')
        }
        const audits = await db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, 'schema.thresholds_updated'))
        assert.equal(audits.length, 3)
      },
    )

    await t.test(
      'default destination settings are audited, validated, and do not redirect saved retries',
      async () => {
        const existing = adapters[1]
        adapters.splice(1)
        assert.equal(
          (await configRequest('settings/export', { defaultDestination: 'google_sheets' })).status,
          400,
        )
        assert.equal(
          (await configRequest('settings/export', { defaultDestination: 'unsupported' })).status,
          400,
        )
        let lose = true
        adapters[1] = {
          destination: 'google_sheets',
          async reserve() {
            return {
              kind: 'google_sheets',
              spreadsheetId: 'mock',
              sheetId: 42,
              row: 2,
              writeHeader: false,
            }
          },
          async send() {
            if (lose) {
              lose = false
              throw new Error('response lost')
            }
            return 'sheets/mock'
          },
        }
        try {
          // The environment default applies before a database override is created.
          const configured = new ExportService(db, adapters, events, {}, validation, pool, {
            EXPORT_DEFAULT_DESTINATION: 'google_sheets',
          })
          const id = await doc('approved')
          const first = await configured.export(id, { exportKey: 'default-sheets' }, user, {})
          assert.equal(first.destination, 'google_sheets')
          assert.equal(first.status, 'failed')
          assert.equal(
            (await configRequest('settings/export', { defaultDestination: 'file_json' })).status,
            200,
          )
          const retry = await request(id, 'export', { exportKey: 'default-sheets' })
          assert.equal(retry.body.id, first.id)
          assert.equal(retry.body.destination, 'google_sheets')
          assert.equal(retry.body.status, 'succeeded')
          assert.equal(
            (await configRequest('settings/export', { defaultDestination: 'google_sheets' }))
              .status,
            200,
          )
          assert.equal(
            (await request(await doc('approved'), 'export', {})).body.destination,
            'google_sheets',
          )
          assert.equal(
            (await request(await doc('approved'), 'export', { destination: 'file_json' })).body
              .destination,
            'file_json',
          )
          const audited = await db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.action, 'export.settings_updated'))
          assert.equal(audited.length, 2)
        } finally {
          adapters[1] = existing
        }
        const env = {
          POSTGRES_HOST: 'localhost',
          POSTGRES_DB: 'test',
          POSTGRES_USER: 'test',
          POSTGRES_PASSWORD: 'test',
          APP_DB_PASSWORD: 'test',
          REDIS_HOST: 'localhost',
          REDIS_PORT: '6379',
          MINIO_ENDPOINT: 'localhost',
          MINIO_PORT: '9000',
          MINIO_ROOT_USER: 'test',
          MINIO_ROOT_PASSWORD: 'test',
          MINIO_BUCKET: 'test',
          JWT_SECRET: 'x'.repeat(32),
        }
        for (const patch of [
          { GOOGLE_SHEETS_KEY_FILE: 'key.json' },
          { GOOGLE_SHEETS_SPREADSHEET_ID: 'id' },
          { GOOGLE_SHEETS_SHEET_NAME: ' ' },
          { GOOGLE_SHEETS_KEY_FILE: ' ' },
          { GOOGLE_SHEETS_SPREADSHEET_ID: 'https://bad' },
          { EXPORT_DEFAULT_DESTINATION: 'google_sheets' },
        ])
          assert.throws(() => loadEnv({ ...env, ...patch }))
        assert.equal(
          loadEnv({
            ...env,
            GOOGLE_SHEETS_KEY_FILE: 'key.json',
            INTEGRATION_KEY_FILE: 'runtime.key',
            GOOGLE_SHEETS_SPREADSHEET_ID: 'valid_id',
            EXPORT_DEFAULT_DESTINATION: 'google_sheets',
          }).EXPORT_DEFAULT_DESTINATION,
          'google_sheets',
        )
      },
    )

    await t.test(
      'seed is idempotent, preserves history and administrator changes, and versions changed seed definitions',
      async () => {
        const originalHistory = await versions()
        await seedSchemas(db)
        const snapshot = await db.select().from(documentSchemas)
        await Promise.all([seedSchemas(db), seedSchemas(db)])
        assert.deepEqual(await db.select().from(documentSchemas), snapshot)
        for (const historical of originalHistory) {
          const saved = (await versions()).find((version) => version.id === historical.id)
          assert.deepEqual({ ...saved, isActive: historical.isActive }, historical)
        }
        const original = await getActiveSchema(db, 'invoice')
        const originalLabel = SEED_SCHEMAS.invoice[0].label
        try {
          SEED_SCHEMAS.invoice[0].label = 'Changed seed label'
          await seedSchemas(db)
          const changed = await getActiveSchema(db, 'invoice')
          assert.equal(changed.version, original.version + 1)
          assert.equal(changed.fields[0].label, 'Changed seed label')
          assert.deepEqual(
            {
              ...(await versions('invoice')).find((version) => version.id === original.id),
              isActive: true,
            },
            original,
          )
          const config = configuration(changed)
          config.fields[0].label = 'Administrator label'
          const customized = await configRequest('schemas/invoice', config)
          assert.equal(customized.status, 200)
          await seedSchemas(db)
          assert.equal((await getActiveSchema(db, 'invoice')).id, customized.body.id)
          SEED_SCHEMAS.invoice[0].label = originalLabel
          await seedSchemas(db)
          assert.equal((await getActiveSchema(db, 'invoice')).version, customized.body.version + 1)
        } finally {
          SEED_SCHEMAS.invoice[0].label = originalLabel
        }
      },
    )
  },
)

// Emulate the Sheets request boundary, including a write that succeeds remotely
// before the caller loses its response. Real adapter allocation uses PostgreSQL.
function mockSheets() {
  const model = {
    spreadsheetId: 'test-spreadsheet',
    title: "O'Brien",
    rows: new Map(),
    writes: [],
    reserveReads: 0,
    loseResponse: false,
    rowCount: 2,
    columnCount: 2,
    beforeWrite: async () => {},
  }
  const check = (request, options) => {
    assert.equal(request.spreadsheetId, model.spreadsheetId)
    assert.equal(options.retry, false)
    assert.ok(options.timeout > 0)
  }
  model.client = {
    spreadsheets: {
      async get(request, options) {
        check(request, options)
        return {
          data: {
            sheets: [
              {
                properties: {
                  sheetId: 7,
                  title: model.title,
                  gridProperties: { rowCount: model.rowCount, columnCount: model.columnCount },
                },
              },
            ],
          },
        }
      },
      async batchUpdate(request, options) {
        check(request, options)
        for (const { appendDimension } of request.requestBody.requests) {
          assert.equal(appendDimension.sheetId, 7)
          model[appendDimension.dimension === 'ROWS' ? 'rowCount' : 'columnCount'] +=
            appendDimension.length
        }
        return {}
      },
      values: {
        async get(request, options) {
          check(request, options)
          assert.equal(request.range, "'O''Brien'")
          model.reserveReads++
          return {
            data: {
              values: Array.from(
                { length: Math.max(-1, ...model.rows.keys()) + 1 },
                (_, i) => model.rows.get(i) ?? [],
              ),
            },
          }
        },
        async append() {
          throw new Error('append would duplicate the exported row')
        },
        async batchUpdateByDataFilter(request, options) {
          check(request, options)
          await model.beforeWrite()
          assert.equal(request.requestBody.valueInputOption, 'RAW')
          model.writes.push(structuredClone(request.requestBody))
          for (const entry of request.requestBody.data) {
            const range = entry.dataFilter.gridRange
            assert.equal(range.sheetId, 7)
            assert.equal(range.endRowIndex, range.startRowIndex + 1)
            assert.ok(range.endRowIndex <= model.rowCount)
            assert.ok(range.endColumnIndex <= model.columnCount)
            model.rows.set(range.startRowIndex, structuredClone(entry.values[0]))
          }
          if (model.loseResponse) {
            model.loseResponse = false
            throw Object.assign(new Error('response lost after row write'), { code: 503 })
          }
          return {}
        },
      },
    },
  }
  return model
}

test(
  'schema migration preserves historical definitions and backfills result bindings',
  { skip: !adminUrl, timeout: 30000 },
  async (t) => {
    const admin = new Pool({ connectionString: adminUrl })
    const name = `docflow_migration_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(adminUrl)
    url.pathname = `/${name}`
    const pool = new Pool({ connectionString: url.href })
    const folder = await mkdtemp(join(tmpdir(), 'docflow-migration-'))
    t.after(async () => {
      await pool.end()
      await admin.query(`DROP DATABASE "${name}"`)
      await admin.end()
      await rm(folder, { recursive: true, force: true })
    })
    await admin.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docflow_app') THEN CREATE ROLE docflow_app; END IF; END $$",
    )
    await cp('packages/core/drizzle', folder, { recursive: true })
    const journalPath = join(folder, 'meta/_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.entries = journal.entries.filter((entry) => entry.idx < 9)
    await writeFile(journalPath, JSON.stringify(journal))
    const db = drizzle(pool)
    await migrate(db, { migrationsFolder: folder })
    const first = randomUUID(),
      second = randomUUID()
    for (const [id, version] of [
      [first, 1],
      [second, 2],
    ])
      await pool.query(
        "insert into document_schemas (id, document_type, version, json_schema, thresholds) values ($1, 'contract', $2, $3, $4)",
        [id, version, JSON.stringify({ fields: specs, rules }), JSON.stringify(DEFAULT_THRESHOLDS)],
      )
    const old = randomUUID(),
      empty = randomUUID()
    for (const id of [old, empty])
      await pool.query(
        "insert into documents (id, tenant_id, source_type, original_filename, mime_type, size_bytes, checksum, storage_key, document_type, status) values ($1, $2, 'upload', 'old.pdf', 'application/pdf', 1, 'test', 'test', 'contract', 'needs_review')",
        [id, randomUUID()],
      )
    await pool.query(
      "insert into fields (document_id, schema_version_id, name, value_type) values ($1, $2, 'name', 'string')",
      [old, first],
    )
    await pool.query(
      "insert into audit_events (actor_type, action, object_type, object_id, after, result) values ('system', 'document.routed', 'document', $1, $2, 'success')",
      [empty, JSON.stringify({ schemaId: first })],
    )
    await migrate(db, { migrationsFolder: 'packages/core/drizzle' })
    const versions = await db.select().from(documentSchemas)
    assert.ok(
      versions.every(
        (version) => JSON.stringify(version.jsonSchema) === JSON.stringify(versions[0].jsonSchema),
      ),
    )
    assert.deepEqual(versions[0].jsonSchema, { fields: specs, rules })
    assert.equal(versions.filter((version) => version.isActive).length, 1)
    assert.equal(versions.find((version) => version.isActive).id, second)
    assert.ok(versions.every((version) => version.exportMapping.length > 0))
    assert.ok(
      (await db.select().from(documents)).every((document) => document.schemaVersionId === first),
    )
    await pool.query('set role docflow_app')
    await pool.query(
      "insert into export_settings (key, default_destination) values ('export', 'file_json')",
    )
    await pool.query('reset role')
  },
)
