import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { loadEnv, StorageService } from '@docflow/core'
import { RetentionService } from '../apps/worker/dist/sync/retention.service.js'
import { evaluationClient } from './eval-client.mjs'

// Only a disposable stack: this check removes and restores its own test original.
assert.equal(process.env.EVAL_DISPOSABLE, '1', 'Set EVAL_DISPOSABLE=1 for an isolated test stack')
const client = await evaluationClient()
const env = loadEnv(process.env, 'api')
const pool = new Pool({ connectionString: env.DATABASE_URL })
const storage = new StorageService(env)
await storage.onModuleInit()
const base = process.env.EVAL_BASE_URL
try {
  const health = await fetch(`${base}/health`)
  assert.deepEqual(await health.json(), { status: 'ok' })
  const logout = await fetch(`${base}/auth/logout`, {
    method: 'POST',
    headers: { cookie: 'docflow_session=invalid' },
  })
  assert.equal(logout.status, 204)
  assert.match(logout.headers.get('set-cookie'), /docflow_session=;/)
  const { items } = await client.json('/documents?status=approved&pageSize=100')
  const approved = items.find((d) => d.isActive && !d.duplicateOfId)
  assert.ok(
    approved,
    'Run the mock dataset evaluation first; an approved test document is required',
  )
  const exported = await client.json(`/documents/${approved.id}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ destination: 'file_json', exportKey: `security-${randomUUID()}` }),
  })
  const exportPath = `/documents/${approved.id}/exports/${exported.id}/file`
  for (const path of [
    `/documents/${approved.id}/file`,
    `/documents/${approved.id}/thumbnail`,
    `/documents/${approved.id}/pages/1/image`,
    exportPath,
    '/documents',
    '/runs',
    '/schemas',
  ]) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, path)
    assert.equal(
      (await fetch(`${base}${path}`, { headers: { cookie: 'docflow_session=invalid' } })).status,
      401,
      path,
    )
  }
  assert.equal((await client.request(exportPath)).status, 200)
  await assert.rejects(
    client.request(`/documents/${randomUUID()}/exports/${exported.id}/file`),
    /HTTP 404/,
  )
  const signed = new URL((await client.json(`/documents/${approved.id}/file`)).url)
  assert.equal(signed.searchParams.get('X-Amz-Expires'), '900')
  assert.equal((await fetch(signed)).status, 200)
  assert.equal((await fetch(`${signed.origin}${signed.pathname}`)).status, 403)
  const shortStorage = new StorageService({ ...env, SIGNED_URL_TTL_SECONDS: 5 })
  await shortStorage.onModuleInit()
  const key = `documents/${randomUUID()}/original.pdf`
  await storage.put(key, Buffer.from('synthetic temporary object'), 'application/pdf')
  const shortLink = await shortStorage.signedUrl(key)
  assert.equal((await fetch(shortLink)).status, 200)
  await delay(6100)
  assert.equal((await fetch(shortLink)).status, 403)
  const [{ lastModified }] = await storage.list(key)
  const retention = new RetentionService(drizzle(pool), env, storage)
  await retention.removeOrphans(new Date(lastModified.getTime() + 24 * 3600000))
  assert.equal((await storage.list(key)).length, 1, 'Object remains at the exact TTL boundary')
  await retention.removeOrphans(new Date(lastModified.getTime() + 24 * 3600000 + 1))
  assert.equal((await storage.list(key)).length, 0, 'Orphan expires after 24h')
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'operator', password: process.env.EVAL_OPERATOR_PASSWORD }),
  })
  assert.equal(login.status, 200)
  const cookie = login.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ')
  assert.equal(
    (
      await fetch(`${base}/settings/export`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ defaultDestination: 'file_json' }),
      })
    ).status,
    403,
  )
  // Produce an actual failed preprocess run for the retry screenshot/video.
  const failed = await client.settle(
    await client.upload(
      `retry-${randomUUID()}.pdf`,
      await readFile('scripts/fixtures/sample-invoice.pdf'),
    ),
  )
  const originalKey = (
    await pool.query('select storage_key from documents where id=$1', [failed.id])
  ).rows[0].storage_key
  const original = await storage.getBuffer(originalKey)
  try {
    await storage.remove(originalKey)
    await client.json(`/documents/${failed.id}/reprocess`, { method: 'POST' })
    let deadLetter
    for (let attempt = 0; attempt < 300; attempt++) {
      deadLetter = (
        await pool.query(
          'select id from dead_letters where document_id=$1 and retried_at is null',
          [failed.id],
        )
      ).rows[0]
      if (deadLetter) break
      await delay(200)
    }
    assert.ok(deadLetter, 'Storage failure reaches the real queue DLQ')
  } finally {
    await storage.put(originalKey, original, 'application/pdf')
  }
  await writeFile(
    'evaluation/security.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        environment: process.env.EVAL_ENVIRONMENT,
        checks: [
          'public health and invalid-cookie logout',
          'anonymous and invalid-session file/API denial',
          'cross-document export download denial',
          'signed URL default 900 seconds and real expiration',
          'private bucket rejects unsigned URL',
          '24-hour orphan boundary on MinIO',
          'operator admin mutation denial',
          'real BullMQ failure and DLQ; original restored for manual retry',
        ],
        retryDocumentId: failed.id,
      },
      null,
      2,
    ) + '\n',
  )
  console.log('Live security checks passed; failed stage is ready for manual retry')
} finally {
  await pool.end()
}
