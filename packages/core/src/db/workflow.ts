import type { WorkflowStep } from '@docflow/shared'
import { and, eq } from 'drizzle-orm'
import type { Database } from './db.module'
import { workflowRuns } from './schema'

/**
 * Журнал выполнения этапов (ТЗ 5.3). Ведётся с этапа 2, чтобы к моменту
 * появления экрана Execution Log история уже накапливалась.
 */

export async function startRun(
  db: Database,
  documentId: string,
  step: WorkflowStep,
  correlationId: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: workflowRuns.id, attempts: workflowRuns.attempts })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.documentId, documentId), eq(workflowRuns.step, step)))
    .limit(1)

  if (existing) {
    // Повтор этапа не создаёт вторую запись: счётчик попыток растёт в той же.
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

  const [created] = await db
    .insert(workflowRuns)
    .values({
      documentId,
      step,
      state: 'running',
      attempts: 1,
      correlationId,
      startedAt: new Date(),
    })
    .returning({ id: workflowRuns.id })
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
