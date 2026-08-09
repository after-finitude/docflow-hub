import { Global, Module } from '@nestjs/common'
import { IngestService } from './ingest.service'

@Global()
@Module({
  providers: [IngestService],
  exports: [IngestService],
})
export class IngestModule {}
