import { isInFlight, type WorkflowStep } from '@docflow/shared'
import { ConflictException } from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from './db.module'
import { single } from './rows'
import { documents, workflowRuns } from './schema'

export interface PipelineJob {
  documentId: string
  correlationId: string
  /** Jobs queued before this column existed belong to revision zero. */
  revision?: number
}

/** Call inside a transaction; every document mutation takes this same row lock. */
export async function lockDocument(db: Database, documentId: string) {
  const [document] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .for('update')
  return document
}

/** An immutable export is waiting for delivery; finish its retry before editing. */
export async function lockDocumentForEdit(db: Database, documentId: string) {
  const document = await lockDocument(db, documentId)
  if (document?.processingStep === 'export') {
    throw new ConflictException('Retry the saved export before changing this document')
  }
  return document
}

/** Both successful writes and failure handlers must discard obsolete worker results. */
export async function lockPipelineDocument(db: Database, job: PipelineJob, step: WorkflowStep) {
  const document = await lockDocument(db, job.documentId)
  if (
    !document ||
    !document.storageKey ||
    document.processingRevision !== (job.revision ?? 0) ||
    document.processingStep !== step ||
    !isInFlight(document.status)
  )
    return null
  return { ...document, storageKey: document.storageKey }
}

export async function beginPipelineRun(db: Database, job: PipelineJob, step: WorkflowStep) {
  return db.transaction(async (tx) => {
    const document = await lockPipelineDocument(tx, job, step)
    if (!document) return null
    const runId = await startRun(tx, job.documentId, step, job.correlationId)
    await tx.update(documents).set({ status: 'processing' }).where(eq(documents.id, job.documentId))
    return { document, runId }
  })
}

/**
 * Stage execution log (spec 5.3), recorded from stage 2 onward.
 */

export async function startRun(
  db: Database,
  documentId: string,
  step: WorkflowStep,
  correlationId: string,
  exportId?: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: workflowRuns.id, attempts: workflowRuns.attempts })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.documentId, documentId),
        eq(workflowRuns.step, step),
        exportId ? eq(workflowRuns.exportId, exportId) : isNull(workflowRuns.exportId),
      ),
    )
    .limit(1)

  if (existing) {
    // A stage retry increments the same entry rather than creating another one.
    await db
      .update(workflowRuns)
      .set({
        state: 'running',
        attempts: existing.attempts + 1,
        startedAt: new Date(),
        finishedAt: null,
        errorCode: null,
        errorDetail: null,
        correlationId,
      })
      .where(eq(workflowRuns.id, existing.id))
    return existing.id
  }

  const created = single(
    await db
      .insert(workflowRuns)
      .values({
        documentId,
        step,
        exportId,
        state: 'running',
        attempts: 1,
        correlationId,
        startedAt: new Date(),
      })
      .returning({ id: workflowRuns.id }),
    'workflow run insert',
  )
  return created.id
}

export async function finishRun(db: Database, runId: string): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ state: 'succeeded', finishedAt: new Date() })
    .where(eq(workflowRuns.id, runId))
}

export async function failRun(
  db: Database,
  runId: string,
  errorCode: string,
  errorDetail?: string,
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ state: 'failed', finishedAt: new Date(), errorCode, errorDetail: errorDetail ?? null })
    .where(eq(workflowRuns.id, runId))
}
