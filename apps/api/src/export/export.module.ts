import { ENV, StorageService, type Env } from '@docflow/core'
import { Module } from '@nestjs/common'
import { EXPORT_ADAPTERS, type ExportAdapter } from './export-adapter'
import { ExportService } from './export.service'
import { FileJsonAdapter } from './file-json.adapter'
import { GoogleSheetsAdapter } from './google-sheets.adapter'

@Module({
  providers: [
    FileJsonAdapter,
    {
      provide: EXPORT_ADAPTERS,
      inject: [ENV, FileJsonAdapter, StorageService],
      useFactory: (env: Env, fileJson: FileJsonAdapter): ExportAdapter[] => {
        const adapters: ExportAdapter[] = [fileJson]
        // Sheets подключается только при настроенном ключе: без него адаптер
        // упал бы не на отсутствии конфигурации, а где-то внутри вызова API.
        if (env.GOOGLE_SHEETS_KEY_FILE && env.GOOGLE_SHEETS_SPREADSHEET_ID) {
          adapters.push(
            new GoogleSheetsAdapter({
              keyFile: env.GOOGLE_SHEETS_KEY_FILE,
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
