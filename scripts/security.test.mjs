import 'reflect-metadata'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import {
  encryptIntegrationSecret,
  readIntegrationSecret,
  readGoogleCredentials,
  loadEnv,
  loadMigrationEnv,
  auditedExternalCall,
} from '@docflow/core'
import { OpenAiCompatibleLlmProvider } from '../apps/worker/dist/llm/openai-compatible-llm.provider.js'
import { GoogleVisionOcrProvider } from '../apps/worker/dist/ocr/google-vision-ocr.provider.js'
import { GoogleSheetsAdapter } from '../apps/api/dist/export/google-sheets.adapter.js'
import { GoogleDriveSource } from '../apps/worker/dist/sync/google-drive.source.js'
import { inspect } from '../apps/worker/dist/preprocess/document-inspector.js'

const env = {
  POSTGRES_HOST: 'localhost',
  POSTGRES_DB: 'test',
  APP_DB_PASSWORD: 'app',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  MINIO_ENDPOINT: 'localhost',
  MINIO_PORT: '9000',
  MINIO_ROOT_USER: 'test',
  MINIO_ROOT_PASSWORD: 'test',
  MINIO_BUCKET: 'test',
}
const secret = 'PRIVATE_DOCUMENT_CONTENT_MUST_NOT_APPEAR'

test('encrypted credentials authenticate contents, reject plaintext/wrong keys, and stay out of runtime owner config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docflow-secret-test-'))
  try {
    const key = join(dir, 'runtime.key'),
      file = join(dir, 'secret.enc')
    execFileSync(process.execPath, ['scripts/integration-secret.mjs', 'keygen', key])
    execFileSync(process.execPath, ['scripts/integration-secret.mjs', 'encrypt', key, file], {
      input: secret,
    })
    assert.equal((await stat(key)).mode & 0o777, 0o600)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const encrypted = await readFile(file, 'utf8')
    assert.equal(encrypted.includes(secret), false)
    assert.equal(readIntegrationSecret(file, key), secret)
    const keyBytes = await readFile(key)
    assert.notEqual(encryptIntegrationSecret(Buffer.from(secret), keyBytes), encrypted)
    const tampered = JSON.parse(encrypted)
    tampered.tag = randomBytes(16).toString('base64')
    await writeFile(file, JSON.stringify(tampered))
    assert.throws(() => readIntegrationSecret(file, key), /Cannot decrypt/)
    await writeFile(file, encrypted)
    await writeFile(key, randomBytes(32))
    assert.throws(() => readIntegrationSecret(file, key), /Cannot decrypt/)
    await writeFile(key, keyBytes)
    await writeFile(file, secret)
    assert.throws(() => readIntegrationSecret(file, key), /Cannot decrypt/)
    await writeFile(file, encrypted)
    const runtime = loadEnv({
      ...env,
      POSTGRES_USER: 'owner',
      POSTGRES_PASSWORD: 'owner-secret',
      SEED_ADMIN_PASSWORD: 'seed-secret',
      LLM_PROVIDER: 'openai_compatible',
      LLM_BASE_URL: 'https://llm.invalid',
      LLM_MODEL: 'test',
      LLM_API_KEY_FILE: file,
      INTEGRATION_KEY_FILE: key,
    })
    assert.equal(runtime.LLM_API_KEY, secret)
    for (const field of [
      'POSTGRES_USER',
      'POSTGRES_PASSWORD',
      'SEED_ADMIN_PASSWORD',
      'MIGRATION_DATABASE_URL',
    ])
      assert.equal(field in runtime, false)
    assert.match(runtime.DATABASE_URL, /docflow_app/)
    assert.equal(
      loadEnv(env).JWT_SECRET,
      undefined,
      'Worker does not require the API signing secret',
    )
    assert.throws(() => loadEnv({ ...env, LLM_API_KEY: secret }), /encrypted/)
    assert.throws(() => loadEnv({ ...env, SIGNED_URL_TTL_SECONDS: '604801' }))
    assert.equal(loadEnv(env).SIGNED_URL_TTL_SECONDS, 900)
    assert.equal(loadEnv(env).RETENTION_DAYS, 90)
    assert.equal(loadEnv(env).ORPHAN_TTL_HOURS, 24)
    assert.match(
      loadMigrationEnv({
        POSTGRES_HOST: 'localhost',
        POSTGRES_DB: 'test',
        POSTGRES_USER: 'owner',
        POSTGRES_PASSWORD: "p'@:/",
      }).MIGRATION_DATABASE_URL,
      /owner:/,
    )
    const credentials = {
      type: 'service_account',
      project_id: 'synthetic',
      client_email: 'service@synthetic.iam.gserviceaccount.com',
      private_key: 'synthetic-key',
    }
    await writeFile(
      file,
      encryptIntegrationSecret(Buffer.from(JSON.stringify(credentials)), keyBytes),
    )
    assert.deepEqual(readGoogleCredentials(file, key), credentials)
    // Real SDK constructors consume decrypted objects, never plaintext key paths.
    const options = { keyFile: file, integrationKeyFile: key }
    const vision = await new GoogleVisionOcrProvider({
      ...options,
      renderDpi: 72,
      languageHints: ['en'],
    }).getClient()
    assert.equal(vision.auth.jsonContent.client_email, credentials.client_email)
    await vision.close()
    const sheets = await new GoogleSheetsAdapter({
      ...options,
      spreadsheetId: 'test',
      sheetName: 'Documents',
    }).client()
    const drive = await new GoogleDriveSource({ ...options, folderId: 'test' }).client()
    // eslint-disable-next-line no-underscore-dangle -- Inspect the actual Google SDK credential object.
    assert.equal(sheets.context._options.auth.jsonContent.client_email, credentials.client_email)
    // eslint-disable-next-line no-underscore-dangle -- Inspect the actual Google SDK credential object.
    assert.equal(drive.context._options.auth.jsonContent.client_email, credentials.client_email)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('external request intent precedes sending, survives failure, and each LLM repair is recorded without contents', async (t) => {
  let calls = 0
  await assert.rejects(
    auditedExternalCall(
      async () => {
        throw new Error('audit unavailable')
      },
      { purpose: 'classification', pages: [1], fields: [], attempt: 1 },
      async () => {
        calls++
      },
    ),
  )
  assert.equal(calls, 0)
  const events = []
  const llm = new OpenAiCompatibleLlmProvider({
    baseUrl: 'https://llm.invalid',
    apiKey: secret,
    model: 'test',
    timeoutMs: 1000,
  })
  t.mock.method(globalThis, 'fetch', async () => {
    assert.equal(events.at(-1).state, 'attempted')
    calls++
    return Response.json({
      choices: [
        {
          message: {
            content:
              calls < 3
                ? secret
                : JSON.stringify({
                    document_type: 'invoice',
                    confidence: 0.9,
                    alternatives: [],
                    multi_document_suspected: false,
                  }),
          },
        },
      ],
    })
  })
  await llm.classify({ pagesText: [{ page: 2, text: secret }] }, async (event) => {
    events.push(event)
  })
  assert.equal(calls, 3)
  assert.deepEqual(
    events.map((e) => e.state),
    ['attempted', 'succeeded', 'attempted', 'succeeded', 'attempted', 'succeeded'],
  )
  assert.deepEqual(
    events.filter((e) => e.state === 'attempted').map((e) => e.attempt),
    [1, 2, 3],
  )
  assert.equal(new Set(events.map((e) => e.callId)).size, 3)
  assert.ok(events.every((e) => e.pages[0] === 2 && e.fields.length === 0))
  assert.equal(JSON.stringify(events).includes(secret), false)
  t.mock.method(globalThis, 'fetch', async () => new Response(secret, { status: 503 }))
  await assert.rejects(
    llm.classify({ pagesText: [{ page: 2, text: secret }] }, async (event) => {
      events.push(event)
    }),
    (error) => error.message === 'LLM API returned HTTP 503' && !error.stack.includes(secret),
  )
  assert.equal(events.at(-1).state, 'failed')
})

test('Vision records a failed page call, disables hidden retries, and provider errors omit document contents', async () => {
  const provider = new GoogleVisionOcrProvider({
    keyFile: 'unused',
    integrationKeyFile: 'unused',
    renderDpi: 72,
    languageHints: ['en'],
  })
  const events = []
  provider.getClient = async () => ({
    documentTextDetection: async (_body, options) => {
      assert.equal(events.at(-1).state, 'attempted')
      assert.equal(options.retry, null)
      throw Object.assign(new Error(secret), { code: 14 })
    },
  })
  const pixels = Buffer.alloc(50 * 50 * 3, 255)
  pixels.fill(0, 0, 50 * 10 * 3)
  const png = await sharp(pixels, { raw: { width: 50, height: 50, channels: 3 } })
    .png()
    .toBuffer()
  await assert.rejects(
    provider.recognize(png, 'image/png', async (event) => {
      events.push(event)
    }),
    (error) => !error.message.includes(secret),
  )
  assert.deepEqual(
    events.map((e) => e.state),
    ['attempted', 'failed'],
  )
  assert.deepEqual(events[0].pages, [1])
  const error = new GoogleSheetsAdapter({}).classify(
    Object.assign(new Error(secret), { status: 503 }),
  )
  assert.equal(error.message.includes(secret), false)
  const source = new GoogleDriveSource({})
  source.client = async () => {
    throw new Error(secret)
  }
  await assert.rejects(source.list(null), /Google Drive listing failed/)
})

test('missing qpdf is a retryable service error rather than a rejected valid file', async () => {
  const original = process.env.PATH
  try {
    process.env.PATH = ''
    await assert.rejects(
      inspect(await readFile('scripts/fixtures/sample-invoice.pdf'), 'application/pdf'),
      /PDF inspection unavailable/,
    )
  } finally {
    process.env.PATH = original
  }
})
