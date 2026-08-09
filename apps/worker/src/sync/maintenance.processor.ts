import {
  ENV,
  MAINTENANCE_JOB,
  PIPELINE_WORKER_OPTIONS,
  QUEUE,
  queueConcurrency,
  type Env,
} from '@docflow/core'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnModuleInit } from '@nestjs/common'
import type { Job } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { RetentionService } from './retention.service'
import { SyncService } from './sync.service'

/**
 * Периодические задачи: синхронизация источника и retention (ТЗ 6.1, 6.9).
 * Отдельная очередь, а не таймер в процессе: при нескольких воркерах задача
 * должна выполняться один раз, и это гарантирует именно очередь.
 */
@Processor(QUEUE.MAINTENANCE, { ...PIPELINE_WORKER_OPTIONS })
export class MaintenanceProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(MaintenanceProcessor.name)

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly sync: SyncService,
    private readonly retention: RetentionService,
  ) {
    super()
  }

  onModuleInit(): void {
    this.worker.concurrency = queueConcurrency(this.env, QUEUE.MAINTENANCE)
  }

  async process(job: Job): Promise<void> {
    const correlationId = randomUUID()

    if (job.name === MAINTENANCE_JOB.SYNC) {
      if (!this.sync.enabled) return
      await this.sync.run(correlationId)
      return
    }

    if (job.name === MAINTENANCE_JOB.RETENTION) {
      await this.retention.run(correlationId)
      return
    }

    this.logger.warn(`Неизвестная периодическая задача ${job.name}`)
  }
}
