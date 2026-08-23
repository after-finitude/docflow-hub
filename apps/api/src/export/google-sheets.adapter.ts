import type { CanonicalDocument, ExportDestination, ExportMapping } from '@docflow/shared'
import { toHeader, toRow } from '@docflow/shared'
import { Injectable, Logger } from '@nestjs/common'
import { DestinationUnavailableError, type ExportAdapter } from './export-adapter'

export interface GoogleSheetsOptions {
  keyFile: string
  spreadsheetId: string
  sheetName: string
}

/** Retryable codes: availability and quota failures, but not permission errors. */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504])

/**
 * Google Sheets via a service account (spec 6.8). Append a mapped row and write
 * the header when the sheet is empty.
 */
@Injectable()
export class GoogleSheetsAdapter implements ExportAdapter {
  readonly destination: ExportDestination = 'google_sheets'

  private readonly logger = new Logger(GoogleSheetsAdapter.name)

  constructor(private readonly options: GoogleSheetsOptions) {}

  async send(
    canonical: CanonicalDocument,
    mapping: ExportMapping,
    exportKey: string,
  ): Promise<string> {
    const sheets = await this.client()
    const range = `${this.options.sheetName}!A:Z`

    try {
      // Write the header once, on the first export to an empty sheet.
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: this.options.spreadsheetId,
        range: `${this.options.sheetName}!A1:A1`,
      })
      if (!existing.data.values?.length) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: this.options.spreadsheetId,
          range: `${this.options.sheetName}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [toHeader(mapping)] },
        })
      }

      const appended = await sheets.spreadsheets.values.append({
        spreadsheetId: this.options.spreadsheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [toRow(canonical, mapping)] },
      })

      const updatedRange = appended.data.updates?.updatedRange ?? range
      return `${this.options.spreadsheetId}#${updatedRange}`
    } catch (error) {
      throw this.classify(error, exportKey)
    }
  }

  /**
   * Convert destination failures to DestinationUnavailableError. Export has no
   * automatic retries; an operator initiates them (spec 6.10). Store the code
   * to distinguish permission errors from network failures.
   */
  private classify(error: unknown, exportKey: string): DestinationUnavailableError {
    const status =
      (error as { code?: number; status?: number }).status ?? (error as { code?: number }).code
    const message = error instanceof Error ? error.message : String(error)
    const transient = typeof status === 'number' && TRANSIENT_STATUSES.has(status)

    this.logger.error(`Export ${exportKey} to Google Sheets failed (${status}): ${message}`)
    return new DestinationUnavailableError(
      transient ? 'sheets_unavailable' : `sheets_error_${status ?? 'unknown'}`,
      `Google Sheets: ${message}`,
    )
  }

  private async client() {
    const { sheets, auth } = await import('@googleapis/sheets')
    const authClient = new auth.GoogleAuth({
      keyFile: this.options.keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
    return sheets({ version: 'v4', auth: authClient })
  }
}
