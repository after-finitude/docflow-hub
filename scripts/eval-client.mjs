import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

/** This client writes synthetic documents; point it at a disposable local stack. */
export async function evaluationClient() {
  const base = process.env.EVAL_BASE_URL
  if (!base || !process.env.EVAL_LOGIN || !process.env.EVAL_PASSWORD)
    throw new Error(
      'Set EVAL_BASE_URL, EVAL_LOGIN and EVAL_PASSWORD for a disposable evaluation stack',
    )
  const auth = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: process.env.EVAL_LOGIN, password: process.env.EVAL_PASSWORD }),
    signal: AbortSignal.timeout(15000),
  })
  if (!auth.ok) throw new Error(`Evaluation login failed: HTTP ${auth.status}`)
  const cookie = auth.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { cookie, ...options.headers },
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response
  }
  const json = async (path, options) => {
    const response = await request(path, options)
    const body = await response.text()
    return body ? JSON.parse(body) : null
  }
  async function upload(file, buffer) {
    const start = performance.now(),
      body = new FormData()
    body.append(
      'file',
      new Blob([buffer ?? (await readFile(file))], {
        type: file.endsWith('.jpg')
          ? 'image/jpeg'
          : file.endsWith('.png')
            ? 'image/png'
            : 'application/pdf',
      }),
      file.split('/').at(-1),
    )
    const created = await json('/documents', { method: 'POST', body })
    return { id: created.id, start }
  }
  async function settle({ id, start }) {
    const timeout = Number(process.env.EVAL_TIMEOUT_MS ?? 180000)
    while (performance.now() - start < timeout) {
      const document = await json(`/documents/${id}`)
      if (!['received', 'processing'].includes(document.status))
        return { ...document, elapsedMs: Math.round(performance.now() - start) }
      await delay(100)
    }
    return {
      id,
      status: 'failed',
      error: 'Evaluation timeout; work may still be running',
      elapsedMs: Math.round(performance.now() - start),
    }
  }
  return { request, json, upload, settle }
}
