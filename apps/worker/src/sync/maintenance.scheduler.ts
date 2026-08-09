import { ENV, MAINTENANCE_JOB, QUEUE, type Env } from '@docflow/core'
import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import { Queue } from 'bullmq'
import { SyncService } from './sync.service'

/**
 * Регистрация повторяющихся задач при старте воркера. Расписание живёт
 * в Redis, поэтому оно обновляется, а не добавляется: смена интервала
 * в конфигурации не должна оставлять работать старый.
 */
@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceScheduler.name)

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly sync: SyncService,
    @InjectQueue(QUEUE.MAINTENANCE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.sync.enabled) {
      await this.queue.upsertJobScheduler(
        MAINTENANCE_JOB.SYNC,
        { every: this.env.SOURCE_SYNC_INTERVAL_SECONDS * 1000 },
        { name: MAINTENANCE_JOB.SYNC },
      )
      this.logger.log(
        `Синхронизация источника ${this.env.SOURCE_PROVIDER} каждые ${this.env.SOURCE_SYNC_INTERVAL_SECONDS} с`,
      )
    } else {
      // Источник отключили — расписание из Redis нужно снять, иначе задача
      // продолжит просыпаться после смены конфигурации.
      await this.queue.removeJobScheduler(MAINTENANCE_JOB.SYNC)
    }

    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOB.RETENTION,
      { every: this.env.RETENTION_INTERVAL_SECONDS * 1000 },
      { name: MAINTENANCE_JOB.RETENTION },
    )

    // Первый прогон — сразу, не через интервал: воркер, простоявший сутки,
    // не должен ждать ещё один период, прежде чем заметит файлы источника
    // и просроченные документы.
    if (this.sync.enabled) await this.queue.add(MAINTENANCE_JOB.SYNC, {})
    await this.queue.add(MAINTENANCE_JOB.RETENTION, {})
  }
}
