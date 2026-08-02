import { DocumentEventsService } from '@docflow/core'
import type { StreamEvent } from '@docflow/shared'
import { Controller, MessageEvent, Sse } from '@nestjs/common'
import { Observable, interval, map, merge } from 'rxjs'

const HEARTBEAT_INTERVAL_MS = 25_000

@Controller('events')
export class EventsController {
  constructor(private readonly events: DocumentEventsService) {}

  /**
   * Живые обновления очереди (ТЗ 5.1). Аутентификация — обычная, по cookie:
   * EventSource отправляет её сам, так как ходит на тот же origin.
   */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    const documents = this.events.stream()

    // Пульс не даёт промежуточным прокси закрыть простаивающее соединение
    // и позволяет клиенту заметить обрыв.
    const heartbeat = interval(HEARTBEAT_INTERVAL_MS).pipe(
      map((): StreamEvent => ({ type: 'heartbeat', at: new Date().toISOString() })),
    )

    return merge(documents, heartbeat).pipe(map((event): MessageEvent => ({ data: event })))
  }
}
