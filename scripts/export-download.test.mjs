import 'reflect-metadata'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Module } from '@nestjs/common'
import { NestFactory, Reflector } from '@nestjs/core'
import { drizzle } from 'drizzle-orm/node-postgres'
import cookieParser from 'cookie-parser'
import { ENV } from '@docflow/core'
import { SESSION_COOKIE_NAME } from '@docflow/shared'
import { DocumentsController } from '../apps/api/dist/documents/documents.controller.js'
import { DocumentFilesService } from '../apps/api/dist/documents/document-files.service.js'
import { DocumentLifecycleService } from '../apps/api/dist/documents/document-lifecycle.service.js'
import { DocumentQueryService } from '../apps/api/dist/documents/document-query.service.js'
import { PageRenderService } from '../apps/api/dist/documents/page-render.service.js'
import { ExportService } from '../apps/api/dist/export/export.service.js'
import { JwtAuthGuard } from '../apps/api/dist/auth/jwt-auth.guard.js'

test('JSON download uses the saved file, requires authentication, and checks document/export identity', async (t) => {
  const documentId = '11111111-1111-4111-8111-111111111111'
  const exportId = '22222222-2222-4222-8222-222222222222'
  const otherId = '33333333-3333-4333-8333-333333333333'
  const saved = Buffer.from('{"documentId":"saved-version","lineItems":[{"amount":1200}]}\n')
  let status = 'succeeded'
  let destination = 'file_json'
  let payloadRef = 'exports/saved.json'
  let storageFailure = false
  let reads = 0
  const db = drizzle({
    async query(query, params) {
      // Exercise real Drizzle SQL generation and mapping, without a database server.
      assert.match(query.text, /^select /)
      if (query.text.includes('from "users"'))
        return { rows: [['operator-id', 'operator', 'operator']] }
      assert.match(query.text, /"exports"\."id" = \$1/)
      assert.match(query.text, /"exports"\."document_id" = \$2/)
      assert.match(query.text, /"exports"\."destination" = \$3/)
      assert.match(query.text, /"exports"\."status" = \$4/)
      const matches =
        params[0] === exportId &&
        params[1] === documentId &&
        params[2] === destination &&
        params[3] === status
      return { rows: matches ? [[payloadRef]] : [] }
    },
  })
  const service = new ExportService(
    db,
    [],
    {},
    {
      async getBuffer(key) {
        assert.equal(key, 'exports/saved.json')
        if (storageFailure) throw new Error('storage unavailable')
        reads++
        return saved
      },
    },
  )
  // eslint-disable-next-line typescript/no-extraneous-class -- Nest attaches module metadata to this class.
  class TestModule {}
  Module({
    controllers: [DocumentsController],
    providers: [
      { provide: DocumentQueryService, useValue: {} },
      { provide: DocumentLifecycleService, useValue: {} },
      { provide: DocumentFilesService, useValue: {} },
      { provide: PageRenderService, useValue: {} },
      { provide: ExportService, useValue: service },
      { provide: ENV, useValue: {} },
    ],
  })(TestModule)
  const app = await NestFactory.create(TestModule, { logger: false })
  app.use(cookieParser())
  app.useGlobalGuards(
    new JwtAuthGuard(
      new Reflector(),
      {
        async verifyAsync(token) {
          assert.equal(token, 'test-session')
          return { sub: 'operator-id' }
        },
      },
      db,
    ),
  )
  await app.listen(0, '127.0.0.1')
  t.after(() => app.close())
  const base = await app.getUrl()
  const path = `/documents/${documentId}/exports/${exportId}/file`
  const options = { headers: { cookie: `${SESSION_COOKIE_NAME}=test-session` } }

  assert.equal((await fetch(base + path)).status, 401)
  assert.equal(reads, 0)
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(base + path, options)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^application\/json/)
    assert.equal(
      response.headers.get('content-disposition'),
      `attachment; filename="docflow-${documentId}.json"`,
    )
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(await response.text(), saved.toString())
  }
  assert.equal(reads, 2)
  for (const badPath of [path.replace(documentId, otherId), path.replace(exportId, otherId)]) {
    assert.equal((await fetch(base + badPath, options)).status, 404)
  }
  assert.equal((await fetch(base + path.replace(exportId, 'invalid'), options)).status, 400)
  for (status of ['pending', 'failed']) {
    assert.equal((await fetch(base + path, options)).status, 404)
  }
  status = 'succeeded'
  destination = 'google_sheets'
  assert.equal((await fetch(base + path, options)).status, 404)
  destination = 'file_json'
  payloadRef = null
  assert.equal((await fetch(base + path, options)).status, 404)
  assert.equal(reads, 2)
  payloadRef = 'exports/saved.json'
  storageFailure = true
  assert.equal((await fetch(base + path, options)).status, 500)
})
