import { ConfigModule, DbModule, EventsModule, QueueModule, StorageModule } from '@docflow/core'
import { Module } from '@nestjs/common'
import { OcrModule } from './ocr/ocr.module'
import { PreprocessModule } from './preprocess/preprocess.module'
import { QueueRegistryService } from './queue-registry.service'

@Module({
  imports: [
    ConfigModule,
    DbModule,
    StorageModule,
    QueueModule,
    EventsModule,
    PreprocessModule,
    OcrModule,
  ],
  providers: [QueueRegistryService],
})
export class AppModule {}
