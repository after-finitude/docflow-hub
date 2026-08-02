import { Global, Module } from '@nestjs/common'
import { DocumentEventsService } from './document-events.service'

@Global()
@Module({
  providers: [DocumentEventsService],
  exports: [DocumentEventsService],
})
export class EventsModule {}
