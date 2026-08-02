import type { DocumentEvent } from '@docflow/shared'
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import { Observable } from 'rxjs'
import { ENV } from '../config/config.module'
import type { Env } from '../config/env'

const CHANNEL = 'docflow:document-events'

/**
 * Живые обновления очереди (ТЗ 5.1). Статусы меняет воркер, а SSE раздаёт API —
 * это разные контейнеры, поэтому нужен внешний канал. Используется pub/sub
 * Redis, который уже есть в стеке под очереди.
 */
@Injectable()
export class DocumentEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(DocumentEventsService.name)
  private readonly publisher: Redis
  /** Соединение в режиме подписки не может выполнять обычные команды — отсюда второе. */
  private subscriber?: Redis

  constructor(@Inject(ENV) private readonly env: Env) {
    this.publisher = new Redis({ host: env.REDIS_HOST, port: env.REDIS_PORT })
  }

  async publish(event: DocumentEvent): Promise<void> {
    try {
      await this.publisher.publish(CHANNEL, JSON.stringify(event))
    } catch (error) {
      // Потеря уведомления не должна ронять обработку документа: клиент
      // всё равно получит актуальное состояние через polling-фолбэк.
      this.logger.warn(`Не удалось опубликовать событие: ${String(error)}`)
    }
  }

  stream(): Observable<DocumentEvent> {
    return new Observable<DocumentEvent>((subscriber) => {
      const connection = new Redis({ host: this.env.REDIS_HOST, port: this.env.REDIS_PORT })
      this.subscriber = connection

      connection.subscribe(CHANNEL).catch((error: unknown) => subscriber.error(error))
      connection.on('message', (_channel, payload) => {
        try {
          subscriber.next(JSON.parse(payload) as DocumentEvent)
        } catch {
          this.logger.warn('Получено событие в нечитаемом формате')
        }
      })
      connection.on('error', (error) => this.logger.warn(`Канал событий: ${error.message}`))

      return () => void connection.quit()
    })
  }

  async onModuleDestroy(): Promise<void> {
    await this.publisher.quit()
    await this.subscriber?.quit()
  }
}
