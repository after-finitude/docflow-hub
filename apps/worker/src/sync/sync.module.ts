import { ENV, type Env } from '@docflow/core'
import { GOOGLE_WORKSPACE_ENABLED } from '@docflow/shared'
import { Module } from '@nestjs/common'
import { GoogleDriveSource } from './google-drive.source'
import { LocalFolderSource } from './local-folder.source'
import { MaintenanceProcessor } from './maintenance.processor'
import { MaintenanceScheduler } from './maintenance.scheduler'
import { RetentionService } from './retention.service'
import { SOURCE_PROVIDER, type SourceProvider } from './source-provider'
import { SyncService } from './sync.service'

/**
 * Secondary source and maintenance jobs. Configuration selects the provider,
 * like OCR and LLM, so sync logic does not depend on a specific source.
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
        if (GOOGLE_WORKSPACE_ENABLED && env.SOURCE_PROVIDER === 'google_drive') {
          return new GoogleDriveSource({
            keyFile: env.GOOGLE_DRIVE_KEY_FILE!,
            integrationKeyFile: env.INTEGRATION_KEY_FILE!,
            folderId: env.GOOGLE_DRIVE_FOLDER_ID!,
          })
        }
        // No source configured; UI upload remains available.
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
