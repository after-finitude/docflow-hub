import { ConfigModule, DbModule, EventsModule, QueueModule, StorageModule } from '@docflow/core'
import { Module } from '@nestjs/common'
import { ClassifyModule } from './classify/classify.module'
import { ExtractModule } from './extract/extract.module'
import { LlmModule } from './llm/llm.module'
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
    LlmModule,
    PreprocessModule,
    OcrModule,
    ClassifyModule,
    ExtractModule,
  ],
  providers: [QueueRegistryService],
})
export class AppModule {}
