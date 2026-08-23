import { ENV, MAINTENANCE_JOB, QUEUE, type Env } from '@docflow/core'
import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import { Queue } from 'bullmq'
import { SyncService } from './sync.service'

/**
 * Register repeatable jobs at worker startup. The schedule lives in Redis, so
 * update rather than append it; changing the configured interval must remove the old one.
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
        `Syncing source ${this.env.SOURCE_PROVIDER} every ${this.env.SOURCE_SYNC_INTERVAL_SECONDS} s`,
      )
    } else {
      // Remove the Redis schedule when the source is disabled so the job stops waking up.
      await this.queue.removeJobScheduler(MAINTENANCE_JOB.SYNC)
    }

    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOB.RETENTION,
      { every: this.env.RETENTION_INTERVAL_SECONDS * 1000 },
      { name: MAINTENANCE_JOB.RETENTION },
    )

    // Run immediately on startup so a worker that was down does not wait another
    // interval before finding source files and expired documents.
    if (this.sync.enabled) await this.queue.add(MAINTENANCE_JOB.SYNC, {})
    await this.queue.add(MAINTENANCE_JOB.RETENTION, {})
  }
}
