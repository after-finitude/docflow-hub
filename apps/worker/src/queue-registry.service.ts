import { ALL_QUEUES, ENV, queueConcurrency, type Env } from '@docflow/core'
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'

/**
 * Пока обработчиков нет (этапы 3–7), сервис показывает при старте
 * фактическую конфигурацию параллелизма по очередям.
 */
@Injectable()
export class QueueRegistryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueRegistryService.name)

  constructor(@Inject(ENV) private readonly env: Env) {}

  onApplicationBootstrap(): void {
    const summary = ALL_QUEUES.map((queue) => `${queue}=${queueConcurrency(this.env, queue)}`).join(
      ', ',
    )
    this.logger.log(`Очереди подключены, параллелизм: ${summary}`)
  }
}
