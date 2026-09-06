import { documentExports, type Database } from '@docflow/core'
import {
  toHeader,
  toRow,
  type CanonicalDocument,
  type ExportDestination,
  type ExportMapping,
  type ExportTarget,
} from '@docflow/shared'
import { Injectable, Logger } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { DestinationUnavailableError, type ExportAdapter } from './export-adapter'

export interface GoogleSheetsOptions {
  keyFile: string
  spreadsheetId: string
  sheetName: string
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504])
const REQUEST_OPTIONS = { timeout: 15000, retry: false }

/** Reserve a row once, then overwrite it on every manual retry (spec 6.8). */
@Injectable()
export class GoogleSheetsAdapter implements ExportAdapter {
  readonly destination: ExportDestination = 'google_sheets'
  private readonly logger = new Logger(GoogleSheetsAdapter.name)

  constructor(private readonly options: GoogleSheetsOptions) {}

  async reserve(db: Database, _exportId: string): Promise<ExportTarget> {
    try {
      const sheets = await this.client()
      const spreadsheetId = this.options.spreadsheetId
      const metadata = await sheets.spreadsheets.get(
        {
          spreadsheetId,
          fields: 'sheets.properties(sheetId,title)',
        },
        REQUEST_OPTIONS,
      )
      const sheet = metadata.data.sheets?.find(
        (s) => s.properties?.title === this.options.sheetName,
      )?.properties
      if (sheet?.sheetId == null) throw new Error('Configured sheet not found')
      const sheetId = sheet.sheetId

      // Different documents share this allocator. The transaction commits the
      // selected row before releasing the lock or making a destination write.
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`docflow-sheet:${spreadsheetId}:${sheetId}`}, 0))`,
      )
      const existing = await sheets.spreadsheets.values.get(
        {
          spreadsheetId,
          range: `'${this.options.sheetName.replaceAll("'", "''")}'`,
        },
        REQUEST_OPTIONS,
      )
      // ponytail: scan used rows when reserving; a persistent high-water counter
      // can replace this read if sheet size makes allocation measurably slow.
      const used = existing.data.values?.length ?? 0
      const [reserved] = await db
        .select({
          row: sql<number>`coalesce(max((${documentExports.target}->>'row')::int), 1)::int`,
        })
        .from(documentExports)
        .where(
          sql`${documentExports.target}->>'spreadsheetId' = ${spreadsheetId} and ${documentExports.target}->>'sheetId' = ${String(sheetId)}`,
        )
      const row = Math.max(1, used, reserved?.row ?? 1) + 1
      return {
        kind: 'google_sheets',
        spreadsheetId,
        sheetId,
        row,
        writeHeader: used === 0 && row === 2,
      }
    } catch (error) {
      throw this.classify(error)
    }
  }

  async send(
    canonical: CanonicalDocument,
    mapping: ExportMapping,
    target: ExportTarget,
  ): Promise<string> {
    if (target.kind !== 'google_sheets') throw new Error('Invalid Sheets export target')
    try {
      const sheets = await this.client()
      const { spreadsheetId, sheetId, row } = target
      const metadata = await sheets.spreadsheets.get(
        {
          spreadsheetId,
          fields: 'sheets.properties(sheetId,gridProperties)',
        },
        REQUEST_OPTIONS,
      )
      const sheet = metadata.data.sheets?.find((s) => s.properties?.sheetId === sheetId)?.properties
      if (!sheet?.gridProperties) throw new Error('Reserved sheet no longer exists')
      const rows = sheet.gridProperties.rowCount ?? 0
      const columns = sheet.gridProperties.columnCount ?? 0
      const requests = [
        ...(row > rows
          ? [{ appendDimension: { sheetId, dimension: 'ROWS', length: row - rows } }]
          : []),
        ...(mapping.length > columns
          ? [
              {
                appendDimension: {
                  sheetId,
                  dimension: 'COLUMNS',
                  length: mapping.length - columns,
                },
              },
            ]
          : []),
      ]
      if (requests.length) {
        // Concurrent growth may leave extra empty rows; it never shifts reserved
        // rows or shrinks a range written by another export.
        await sheets.spreadsheets.batchUpdate(
          { spreadsheetId, requestBody: { requests } },
          REQUEST_OPTIONS,
        )
      }
      const range = (startRowIndex: number) => ({
        sheetId,
        startRowIndex,
        endRowIndex: startRowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: mapping.length,
      })
      // Numeric sheet identity survives a renamed tab. No values.append call:
      // a lost response is safely retried at the exact same persisted address.
      await sheets.spreadsheets.values.batchUpdateByDataFilter(
        {
          spreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
              ...(target.writeHeader
                ? [{ dataFilter: { gridRange: range(0) }, values: [toHeader(mapping)] }]
                : []),
              {
                dataFilter: { gridRange: range(row - 1) },
                values: [toRow(canonical, mapping).map((value) => value ?? '')],
              },
            ],
          },
        },
        REQUEST_OPTIONS,
      )
      return `${spreadsheetId}#gid=${sheetId}&range=A${row}`
    } catch (error) {
      throw this.classify(error)
    }
  }

  private classify(error: unknown): DestinationUnavailableError {
    const status =
      (error as { code?: number; status?: number }).status ?? (error as { code?: number }).code
    const message = error instanceof Error ? error.message : String(error)
    const transient = typeof status === 'number' && TRANSIENT_STATUSES.has(status)
    this.logger.error(`Google Sheets export failed (${status}): ${message}`)
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
