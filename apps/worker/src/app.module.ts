import {
  ConfigModule,
  DbModule,
  EventsModule,
  IngestModule,
  QueueModule,
  StorageModule,
  ValidationModule,
} from '@docflow/core'
import { Module } from '@nestjs/common'
import { ClassifyModule } from './classify/classify.module'
import { ExtractModule } from './extract/extract.module'
import { LlmModule } from './llm/llm.module'
import { OcrModule } from './ocr/ocr.module'
import { PreprocessModule } from './preprocess/preprocess.module'
import { QueueRegistryService } from './queue-registry.service'
import { SyncModule } from './sync/sync.module'
import { ValidateModule } from './validate/validate.module'

@Module({
  imports: [
    ConfigModule,
    DbModule,
    StorageModule,
    QueueModule,
    EventsModule,
    ValidationModule,
    IngestModule,
    LlmModule,
    PreprocessModule,
    OcrModule,
    ClassifyModule,
    ExtractModule,
    ValidateModule,
    SyncModule,
  ],
  providers: [QueueRegistryService],
})
export class AppModule {}
