import { DocumentEventsService } from '@docflow/core'
import type { StreamEvent } from '@docflow/shared'
import { Controller, MessageEvent, Sse } from '@nestjs/common'
import { Observable, interval, map, merge } from 'rxjs'

const HEARTBEAT_INTERVAL_MS = 25_000

@Controller('events')
export class EventsController {
  constructor(private readonly events: DocumentEventsService) {}

  /**
   * Live queue updates (spec 5.1). EventSource sends the normal session cookie
   * because it connects through the same origin.
   */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    const documents = this.events.stream()

    // Heartbeats keep intermediary proxies from closing an idle connection
    // and let the client detect disconnects.
    const heartbeat = interval(HEARTBEAT_INTERVAL_MS).pipe(
      map((): StreamEvent => ({ type: 'heartbeat', at: new Date().toISOString() })),
    )

    return merge(documents, heartbeat).pipe(map((event): MessageEvent => ({ data: event })))
  }
}
