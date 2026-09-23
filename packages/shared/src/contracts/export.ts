import { z } from 'zod'
import { EXPORT_DESTINATIONS, type ExportDestination, type ExportStatus } from '../enums'

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
