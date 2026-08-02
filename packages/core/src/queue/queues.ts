import type { JobsOptions } from 'bullmq'
import type { Env } from '../config/env'

/**
 * По очереди на этап pipeline: параллелизм настраивается отдельно
 * для дорогих этапов (ТЗ 6.10).
 */
export const QUEUE = {
  PREPROCESS: 'preprocess',
  OCR: 'ocr',
  CLASSIFY: 'classify',
  EXTRACT: 'extract',
  VALIDATE: 'validate',
  EXPORT: 'export',
} as const

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE]

export const ALL_QUEUES: QueueName[] = Object.values(QUEUE)

/** Имя пользовательской стратегии backoff, регистрируется в настройках воркера. */
export const PIPELINE_BACKOFF = 'pipeline'

/**
 * Транзиентные ошибки внешних вызовов: 3 попытки, задержки 1с / 5с / 25с
 * (ТЗ 6.10). При attempts = 3 расходуются первые две задержки.
 */
export function pipelineBackoffStrategy(attemptsMade: number): number {
  return 1000 * 5 ** Math.max(0, attemptsMade - 1)
}

/**
 * Настройки воркера, без которых задержки выше не применятся: BullMQ ищет
 * пользовательскую стратегию именно в settings воркера. Каждый процессор
 * pipeline обязан разложить этот объект в свои опции, иначе backoff из ТЗ 6.10
 * молча не заработает.
 */
export const PIPELINE_WORKER_OPTIONS = {
  settings: { backoffStrategy: pipelineBackoffStrategy },
} as const

export const PIPELINE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: PIPELINE_BACKOFF },
  removeOnComplete: { age: 86_400, count: 1000 },
  // Упавшие задачи сохраняются: их видно в Inbox как Failed и они доступны
  // для ручного Reprocess.
  removeOnFail: false,
}

/** Экспорт автоматически не повторяется, только вручную (ТЗ 6.8, 6.10). */
export const EXPORT_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 86_400, count: 1000 },
  removeOnFail: false,
}

export function defaultJobOptionsFor(queue: QueueName): JobsOptions {
  return queue === QUEUE.EXPORT ? EXPORT_JOB_OPTIONS : PIPELINE_JOB_OPTIONS
}

export function queueConcurrency(env: Env, queue: QueueName): number {
  if (queue === QUEUE.OCR && env.QUEUE_CONCURRENCY_OCR) return env.QUEUE_CONCURRENCY_OCR
  if (queue === QUEUE.EXTRACT && env.QUEUE_CONCURRENCY_EXTRACT) return env.QUEUE_CONCURRENCY_EXTRACT
  return env.QUEUE_CONCURRENCY_DEFAULT
}
