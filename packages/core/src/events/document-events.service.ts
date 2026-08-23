import type { DocumentEvent } from '@docflow/shared'
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import { Observable } from 'rxjs'
import { ENV } from '../config/config.module'
import type { Env } from '../config/env'

const CHANNEL = 'docflow:document-events'

/**
 * Live queue updates (spec 5.1). Workers change statuses while the API serves
 * SSE from another container, so use the existing Redis pub/sub channel.
 */
@Injectable()
export class DocumentEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(DocumentEventsService.name)
  private readonly publisher: Redis
  /** A subscribed connection cannot run regular commands, so use a second connection. */
  private subscriber?: Redis

  constructor(@Inject(ENV) private readonly env: Env) {
    this.publisher = new Redis({ host: env.REDIS_HOST, port: env.REDIS_PORT })
  }

  async publish(event: DocumentEvent): Promise<void> {
    try {
      await this.publisher.publish(CHANNEL, JSON.stringify(event))
    } catch (error) {
      // A lost notification must not fail document processing; polling still
      // gives clients the latest state.
      this.logger.warn(`Could not publish event: ${String(error)}`)
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
          this.logger.warn('Received an unreadable event')
        }
      })
      connection.on('error', (error) => this.logger.warn(`Event channel: ${error.message}`))

      return () => void connection.quit()
    })
  }

  async onModuleDestroy(): Promise<void> {
    await this.publisher.quit()
    await this.subscriber?.quit()
  }
}
