import { ENV, StorageService, type Env } from '@docflow/core'
import { GOOGLE_WORKSPACE_ENABLED } from '@docflow/shared'
import { Module } from '@nestjs/common'
import { EXPORT_ADAPTERS, type ExportAdapter } from './export-adapter'
import { ExportService } from './export.service'
import { ExportSettingsController } from './export-settings.controller'
import { FileJsonAdapter } from './file-json.adapter'
import { GoogleSheetsAdapter } from './google-sheets.adapter'

@Module({
  controllers: [ExportSettingsController],
  providers: [
    FileJsonAdapter,
    {
      provide: EXPORT_ADAPTERS,
      inject: [ENV, FileJsonAdapter, StorageService],
      useFactory: (env: Env, fileJson: FileJsonAdapter): ExportAdapter[] => {
        const adapters: ExportAdapter[] = [fileJson]
        // Enable Sheets only when credentials are configured so a missing key
        // fails at configuration time rather than inside an API call.
        if (
          GOOGLE_WORKSPACE_ENABLED &&
          env.GOOGLE_SHEETS_KEY_FILE &&
          env.GOOGLE_SHEETS_SPREADSHEET_ID
        ) {
          adapters.push(
            new GoogleSheetsAdapter({
              keyFile: env.GOOGLE_SHEETS_KEY_FILE,
              integrationKeyFile: env.INTEGRATION_KEY_FILE!,
              spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
              sheetName: env.GOOGLE_SHEETS_SHEET_NAME,
            }),
          )
        }
        return adapters
      },
    },
    ExportService,
  ],
  exports: [ExportService],
})
export class ExportModule {}
