import { ENV, type Env } from '@docflow/core'
import { Module } from '@nestjs/common'
import { GoogleDriveSource } from './google-drive.source'
import { LocalFolderSource } from './local-folder.source'
import { MaintenanceProcessor } from './maintenance.processor'
import { MaintenanceScheduler } from './maintenance.scheduler'
import { RetentionService } from './retention.service'
import { SOURCE_PROVIDER, type SourceProvider } from './source-provider'
import { SyncService } from './sync.service'

/**
 * Второй источник и периодические задачи. Провайдер выбирается конфигурацией
 * так же, как OCR и LLM: код синхронизации о конкретном источнике не знает.
 */
@Module({
  providers: [
    {
      provide: SOURCE_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env): SourceProvider | null => {
        if (env.SOURCE_PROVIDER === 'local_folder') {
          return new LocalFolderSource(env.LOCAL_SOURCE_DIR!)
        }
        if (env.SOURCE_PROVIDER === 'google_drive') {
          return new GoogleDriveSource({
            keyFile: env.GOOGLE_DRIVE_KEY_FILE!,
            folderId: env.GOOGLE_DRIVE_FOLDER_ID!,
          })
        }
        // Источник не настроен: остаётся только загрузка через интерфейс.
        return null
      },
    },
    SyncService,
    RetentionService,
    MaintenanceScheduler,
    MaintenanceProcessor,
  ],
})
export class SyncModule {}
