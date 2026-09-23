import { UPLOAD_MAX_BYTES } from '@docflow/shared/browser'

/** Large files send only metadata, preserving the server's bounded upload buffer. */
export function uploadFile(file: File, replaces?: string): Promise<Response> {
  if (file.size > UPLOAD_MAX_BYTES) {
    return fetch('/api/documents/oversized', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size }),
    })
  }
  const body = new FormData()
  body.append('file', file)
  return fetch(replaces ? `/api/documents/${replaces}/file` : '/api/documents', {
    method: 'POST',
    body,
  })
}
