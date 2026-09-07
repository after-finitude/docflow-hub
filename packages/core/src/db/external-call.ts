import { randomUUID } from 'node:crypto'
import { writeAudit } from './audit'
import type { Database } from './db.module'

export interface ExternalCallDetails {
  purpose: 'ocr' | 'classification' | 'extraction' | 'export'
  pages: number[]
  fields: string[]
  attempt: number
  rotationDegrees?: number
}

export type ExternalCallRecorder = (
  event: ExternalCallDetails & {
    callId: string
    state: 'attempted' | 'succeeded' | 'failed'
  },
) => Promise<void>

/** Commit intent before sending; a crash leaves an explicit unknown outcome. */
export async function auditedExternalCall<T>(
  record: ExternalCallRecorder | undefined,
  details: ExternalCallDetails,
  request: () => Promise<T>,
): Promise<T> {
  const callId = randomUUID()
  await record?.({ ...details, callId, state: 'attempted' })
  let result: T
  try {
    result = await request()
  } catch (error) {
    await record?.({ ...details, callId, state: 'failed' })
    throw error
  }
  await record?.({ ...details, callId, state: 'succeeded' })
  return result
}

export function externalCallRecorder(
  db: Database,
  context: {
    documentId: string
    correlationId: string
    runId: string
    provider: string
  },
): ExternalCallRecorder {
  return (event) =>
    writeAudit(db, {
      correlationId: context.correlationId,
      actorType: 'system',
      action: 'document.provider_call',
      objectType: 'document',
      objectId: context.documentId,
      after: { provider: context.provider, runId: context.runId, ...event },
      result: event.state === 'failed' ? 'failure' : 'success',
    })
}
