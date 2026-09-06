import { z } from 'zod'
import type { ExportStatus } from '../enums'

/** Required destination adapters (spec 6.8). */
export const EXPORT_DESTINATIONS = ['file_json', 'google_sheets'] as const
export type ExportDestination = (typeof EXPORT_DESTINATIONS)[number]

export const EXPORT_DESTINATION_LABELS: Record<ExportDestination, string> = {
  file_json: 'JSON file',
  google_sheets: 'Google Sheets',
}

export const exportRequestSchema = z.object({
  destination: z.enum(EXPORT_DESTINATIONS).optional(),
  /**
   * Idempotency key derived by default from document and destination so a
   * repeated request does not create another object (spec §9).
   */
  exportKey: z.string().min(1).max(200).optional(),
})
export type ExportRequest = z.infer<typeof exportRequestSchema>

export interface ExportDto {
  id: string
  destination: ExportDestination
  exportKey: string
  status: ExportStatus
  payloadRef: string | null
  errorCode: string | null
  attempts: number
  exportedAt: string | null
}

/** Persisted before a destination write. Retries always use this same address. */
export type ExportTarget =
  | { kind: 'file_json'; objectKey: string }
  | {
      kind: 'google_sheets'
      spreadsheetId: string
      sheetId: number
      row: number
      writeHeader: boolean
    }

export const exportSettingsSchema = z
  .object({
    defaultDestination: z.enum(EXPORT_DESTINATIONS),
  })
  .strict()
export type ExportSettings = z.infer<typeof exportSettingsSchema>
