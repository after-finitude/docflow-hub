import { ALL_QUEUES, ENV, queueConcurrency, type Env } from '@docflow/core'
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'

/**
 * Until processors are added in stages 3–7, log the effective per-queue
 * concurrency configuration at startup.
 */
@Injectable()
export class QueueRegistryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueRegistryService.name)

  constructor(@Inject(ENV) private readonly env: Env) {}

  onApplicationBootstrap(): void {
    const summary = ALL_QUEUES.map((queue) => `${queue}=${queueConcurrency(this.env, queue)}`).join(
      ', ',
    )
    this.logger.log(`Queues connected, concurrency: ${summary}`)
  }
}
