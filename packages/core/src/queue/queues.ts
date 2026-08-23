import type { JobsOptions } from 'bullmq'
import type { Env } from '../config/env'

/**
 * One queue per pipeline stage, with separate concurrency for expensive stages
 * (spec 6.10).
 */
export const QUEUE = {
  PREPROCESS: 'preprocess',
  OCR: 'ocr',
  CLASSIFY: 'classify',
  EXTRACT: 'extract',
  VALIDATE: 'validate',
  EXPORT: 'export',
  /** Periodic source sync and retention jobs (spec 6.1, 6.9). */
  MAINTENANCE: 'maintenance',
} as const

/** Repeatable maintenance queue job names. */
export const MAINTENANCE_JOB = {
  SYNC: 'sync',
  RETENTION: 'retention',
} as const

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE]

export const ALL_QUEUES: QueueName[] = Object.values(QUEUE)

/** Custom backoff strategy name registered in worker settings. */
export const PIPELINE_BACKOFF = 'pipeline'

/**
 * Transient external failures: three attempts with 1s / 5s / 25s delays
 * (spec 6.10). attempts = 3 consumes the first two delays.
 */
export function pipelineBackoffStrategy(attemptsMade: number): number {
  return 1000 * 5 ** Math.max(0, attemptsMade - 1)
}

/**
 * Worker settings required for the delays above. BullMQ resolves custom backoff
 * strategies from worker settings, so every pipeline processor must include this object.
 */
export const PIPELINE_WORKER_OPTIONS = {
  settings: { backoffStrategy: pipelineBackoffStrategy },
} as const

export const PIPELINE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: PIPELINE_BACKOFF },
  removeOnComplete: { age: 86_400, count: 1000 },
  // Keep failed jobs visible in Inbox and available for manual Reprocess.
  removeOnFail: false,
}

/** Export retries are manual only (spec 6.8, 6.10). */
export const EXPORT_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 86_400, count: 1000 },
  removeOnFail: false,
}

/**
 * Periodic jobs do not retry because the schedule supplies the next run. Retain
 * failures for a limited time to prevent unbounded Redis growth.
 */
export const MAINTENANCE_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 86_400, count: 50 },
  removeOnFail: { age: 604_800, count: 50 },
}

export function defaultJobOptionsFor(queue: QueueName): JobsOptions {
  if (queue === QUEUE.EXPORT) return EXPORT_JOB_OPTIONS
  if (queue === QUEUE.MAINTENANCE) return MAINTENANCE_JOB_OPTIONS
  return PIPELINE_JOB_OPTIONS
}

export function queueConcurrency(env: Env, queue: QueueName): number {
  if (queue === QUEUE.OCR && env.QUEUE_CONCURRENCY_OCR) return env.QUEUE_CONCURRENCY_OCR
  if (queue === QUEUE.EXTRACT && env.QUEUE_CONCURRENCY_EXTRACT) return env.QUEUE_CONCURRENCY_EXTRACT
  // Serialize sync and retention so parallel source passes cannot ingest one file twice.
  if (queue === QUEUE.MAINTENANCE) return 1
  return env.QUEUE_CONCURRENCY_DEFAULT
}
